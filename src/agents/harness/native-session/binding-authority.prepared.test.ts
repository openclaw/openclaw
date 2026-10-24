import { copyFileSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createTestReplyOperation } from "../../../auto-reply/reply/reply-run-registry.test-helpers.js";
import { prepareReplyToolAuthority } from "../../../auto-reply/reply/reply-tool-authority.js";
import {
  createQueueTestRun,
  toolAuthorityOverlay,
} from "../../../auto-reply/reply/reply-tool-authority.test-support.js";
import { captureRuntimeConfigAsyncReader } from "../../../config/config.js";
import {
  loadSessionEntryReadOnly,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import * as sessionReads from "../../../config/sessions/session-entry-read-runtime.js";
import { testing } from "../../../sessions/session-controller.test-support.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  bindWorkerToolPreparation,
  prepareReplyToolAuthorityCallerRead,
  recordPreparedToolAuthorityRead,
} from "../host-private-capabilities.js";
import { createNativeSessionBindingAuthority } from "./binding-authority.js";
import { bindingGate } from "./binding-interleaving.test-support.js";

const nativeKey = "agent:main:native-lineage";
afterEach(() => {
  testing.resetSessionControllerForTest();
  vi.restoreAllMocks();
});

it.each([
  "metadata",
  "malformed",
  "policy",
  "route",
  "partial",
  "refusal",
  "compat-refusal",
  "legacy-allowed",
  "source-replaced",
] as const)("keeps fresh tool policy and native lineage at final admission: %s", async (change) => {
  const state = await createOpenClawTestState({ scenario: "minimal" });
  onTestFinished(() => state.cleanup());
  const env = state.env;
  await captureRuntimeConfigAsyncReader()();
  const nativeRead = {
    agentId: "main",
    sessionKey: nativeKey,
    env,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  await upsertSessionEntryCore(nativeRead, { sessionId: "native", updatedAt: 1 });
  await closeOpenClawAgentDatabaseByPathAsync(nativeRead.storePath, "main");
  const authority = createNativeSessionBindingAuthority(
    [
      {
        read: nativeRead,
        sessionId: "native",
        createSupersededError: () => new Error("superseded"),
      },
    ],
    () => {},
  );
  const policyKey = "agent:policy:steering-policy";
  const compatibility = ["partial", "compat-refusal", "legacy-allowed"].includes(change);
  const refusal = change === "refusal" || change === "compat-refusal";
  await upsertSessionEntryCore(
    { agentId: "policy", sessionKey: policyKey },
    { sessionId: "policy", updatedAt: 1, sandboxMode: "off" },
  );
  // Drain seed maintenance before measuring the final authority read.
  await closeOpenClawAgentDatabaseByPathAsync(
    resolveOpenClawAgentSqlitePath({ agentId: "policy", env }),
    "policy",
  );
  const run = createQueueTestRun({ prompt: "authority" });
  Object.assign(run.run, {
    sessionKey: "agent:main:authority-execution",
    runtimePolicySessionKey: policyKey,
    agentId: "main",
    config: {
      agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {}, policy: {} } },
      tools: { sandbox: { tools: { deny: ["exec"] } } },
    },
  });
  const operation = createTestReplyOperation({
    sessionKey: run.run.sessionKey,
    sessionId: run.run.sessionId,
  });
  await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
  const admitted = await operation.bindToolAuthorityRouteAsync(run.run);
  const compatAssertCurrent = vi.fn(() => {
    if (change === "legacy-allowed") {
      expect(
        loadSessionEntryReadOnly({
          ...nativeRead,
          readConsistency: "latest",
        })?.sessionId,
      ).toBe("native");
      return;
    }
    if (change === "compat-refusal" && operation.sessionId === run.run.sessionId) {
      return;
    }
    throw new Error("legacy policy revoked");
  });
  await using gate = bindingGate();
  const pauseAdmission = async () => {
    finalAdmissionEntered = true;
    await gate.pause();
  };
  const preparation = bindWorkerToolPreparation({
    assertCurrent() {},
    compatAssertCurrent,
    async prepareCurrent() {
      const projected = await operation.projectToolAuthorityFingerprintAsync(
        toolAuthorityOverlay(run),
      );
      if (projected !== admitted) {
        throw new Error("policy no longer matches");
      }
      if (compatibility || change === "source-replaced") {
        await prepareReplyToolAuthorityCallerRead({}, undefined, admitted, run.run, () => {});
        await pauseAdmission();
      }
    },
  });
  let finalAdmissionEntered = false;
  const onRefused = vi.fn(() => {
    operation.updateSessionId("replacement");
    return "discarded" as const;
  });
  const assertOtherCurrent = () => {
    if (finalAdmissionEntered) {
      throw new Error("other sender revoked");
    }
  };
  const read = sessionReads.withSessionEntriesFromStoresInWorker;
  const delayed = vi
    .spyOn(sessionReads, "withSessionEntriesFromStoresInWorker")
    .mockImplementation(async (inputs, consume, options) => {
      if (inputs.some((input) => input.sessionKeys?.includes(nativeKey))) {
        await pauseAdmission();
      }
      return read(inputs, consume, options);
    });
  const consumed = vi.fn(() => "admitted");
  const calls = observeMainThreadSql();
  const preparations = [preparation];
  if (refusal) {
    preparations.push(
      bindWorkerToolPreparation({
        assertCurrent: assertOtherCurrent,
        compatAssertCurrent: vi.fn(),
        async prepareCurrent() {
          recordPreparedToolAuthorityRead({
            reads: [],
            assertPrepared: assertOtherCurrent,
            assertLegacyCurrent: assertOtherCurrent,
          });
        },
        onRefused,
      }),
    );
  }
  const outcome = gate.observe(authority.withPreparedCurrent!(consumed, preparations));
  try {
    await gate.wait(outcome, "Final admission was not reached");
    calls.expectIdle();
    if (change === "policy" || change === "metadata") {
      await updateSessionEntry({ agentId: "policy", sessionKey: policyKey }, () =>
        change === "policy" ? { sandboxMode: undefined } : { label: "renamed" },
      );
      calls.clear();
    } else if (change === "malformed") {
      await runOpenClawAgentWriteAdmission({ agentId: "policy", env }, ({ canonicalPath }) => {
        {
          using corrupted = new DatabaseSync(canonicalPath);
          corrupted
            .prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.sessionId', 42) WHERE session_key = ?",
            )
            .run(policyKey);
        }
        // Exercise malformed-row parsing rather than a warmed fact or revoked source.
        sessionChanges.invalidate({
          agentId: "policy",
          sessionKey: policyKey,
          storePath: canonicalPath,
          factsInvalidated: true,
        });
      });
      calls.clear();
    } else if (change === "route") {
      await operation.bindToolAuthorityRouteAsync({
        provider: run.run.provider,
        model: "changed-model",
      });
    } else if (change === "source-replaced") {
      const { storePath } = nativeRead;
      copyFileSync(storePath, `${storePath}.replacement`);
      renameSync(`${storePath}.replacement`, storePath);
    }
    gate.resume();
    const result = await outcome;
    if (change !== "legacy-allowed") {
      calls.expectIdle();
    }
    if (change === "metadata" || change === "legacy-allowed") {
      expect(result).toBe("admitted");
      expect(consumed).toHaveBeenCalledOnce();
    } else {
      expect(result).toBeInstanceOf(Error);
      if (change === "malformed") {
        expect(result).toHaveProperty(
          "message",
          expect.stringContaining(`invalid persisted session row requires repair for ${policyKey}`),
        );
      } else if (change === "source-replaced") {
        expect(result).toMatchObject({
          message: "Native session lineage source changed during tool preparation",
        });
      }
      expect(consumed).not.toHaveBeenCalled();
    }
    expect(compatAssertCurrent).toHaveBeenCalledTimes(compatibility ? 1 : 0);
    expect(onRefused).toHaveBeenCalledTimes(refusal ? 1 : 0);
  } finally {
    gate.resume();
    await outcome;
    calls.restore();
    delayed.mockRestore();
  }
});
