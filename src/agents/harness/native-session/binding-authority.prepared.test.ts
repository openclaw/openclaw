import { copyFileSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { createQueueTestRun } from "../../../auto-reply/reply/queue.test-helpers.js";
import { createTestReplyOperation } from "../../../auto-reply/reply/reply-run-registry.test-helpers.js";
import { testing } from "../../../auto-reply/reply/reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "../../../auto-reply/reply/reply-tool-authority.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import * as sessionReads from "../../../config/sessions/session-entry-read-runtime.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  bindWorkerToolPreparation,
  prepareReplyToolAuthorityCallerRead,
  recordPreparedToolAuthorityRead,
} from "../host-private-capabilities.js";
import { createNativeSessionBindingAuthority } from "./binding-authority.js";

afterEach(() => {
  testing.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

it.each([
  "unchanged",
  "metadata",
  "malformed",
  "policy",
  "route",
  "partial",
  "refusal",
  "compat-refusal",
  "legacy-allowed",
] as const)("keeps fresh tool policy and native lineage at final admission: %s", async (change) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const nativeKey = "agent:main:native-lineage";
    const policyKey = "agent:policy:steering-policy";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: nativeKey },
      { sessionId: "native", updatedAt: 1 },
    );
    await upsertSessionEntryCore(
      { agentId: "policy", sessionKey: policyKey },
      { sessionId: "policy", updatedAt: 1, sandboxMode: "off" },
    );
    // Seed writes schedule maintenance; drain it before racing the foreign policy writer.
    for (const agentId of ["main", "policy"]) {
      await closeOpenClawAgentDatabaseByPathAsync(
        resolveOpenClawAgentSqlitePath({ agentId, env: state.env }),
        agentId,
      );
    }
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
    const authority = createNativeSessionBindingAuthority(
      [
        {
          read: {
            agentId: "main",
            sessionKey: nativeKey,
            storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
            env: state.env,
          },
          sessionId: "native",
          createSupersededError: () => new Error("native lineage superseded"),
        },
      ],
      () => {},
    );
    const compatAssertCurrent = vi.fn(() => {
      if (change === "legacy-allowed") {
        expect(
          loadSessionEntryReadOnly({
            agentId: "main",
            sessionKey: nativeKey,
            storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
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
    const preparation = bindWorkerToolPreparation({
      assertCurrent() {},
      compatAssertCurrent,
      async prepareCurrent() {
        const projected = await operation.projectToolAuthorityFingerprintAsync({
          senderIsOwner: run.run.senderIsOwner === true,
          disableTools: false,
          traceAuthorized: false,
        });
        if (projected !== admitted) {
          throw new Error("policy no longer matches");
        }
        if (change === "partial" || change === "compat-refusal" || change === "legacy-allowed") {
          await prepareReplyToolAuthorityCallerRead({}, undefined, admitted, run.run, () => {});
          finalAdmissionEntered = true;
          entered.resolve();
          await resume.promise;
        }
      },
    });
    const entered = createDeferred();
    const resume = createDeferred();
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
          finalAdmissionEntered = true;
          entered.resolve();
          await resume.promise;
        }
        return read(inputs, consume, options);
      });
    const consumed = vi.fn(() => "admitted");
    const calls = observeMainThreadSql();
    const outcome = authority.withPreparedCurrent!(consumed, [
      preparation,
      ...(change === "refusal" || change === "compat-refusal"
        ? [
            bindWorkerToolPreparation({
              assertCurrent: assertOtherCurrent,
              compatAssertCurrent() {},
              async prepareCurrent() {
                recordPreparedToolAuthorityRead({
                  reads: [],
                  assertPrepared: assertOtherCurrent,
                  assertLegacyCurrent: assertOtherCurrent,
                });
              },
              onRefused,
            }),
          ]
        : []),
    ]).catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(entered.promise, outcome, "Final admission was not reached");
      calls.expectIdle();
      if (change === "policy" || change === "metadata" || change === "malformed") {
        // Setup starts worker maintenance; share its writer lane without publishing the mutation.
        await runOpenClawAgentWriteAdmission(
          { agentId: "policy", env: state.env },
          ({ canonicalPath }) => {
            const foreign = new DatabaseSync(canonicalPath);
            try {
              foreign
                .prepare(
                  change === "policy"
                    ? "UPDATE session_nodes SET entry_json = json_remove(entry_json, '$.sandboxMode') WHERE session_key = ?"
                    : change === "metadata"
                      ? "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', 'renamed') WHERE session_key = ?"
                      : "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.sessionId', 42) WHERE session_key = ?",
                )
                .run(policyKey);
            } finally {
              foreign.close();
            }
          },
        );
        calls.clear();
      } else if (change === "route") {
        await operation.bindToolAuthorityRouteAsync({
          provider: run.run.provider,
          model: "changed-model",
        });
      }
      resume.resolve();
      const result = await outcome;
      if (change !== "legacy-allowed") {
        calls.expectIdle();
      }
      if (change === "unchanged" || change === "metadata" || change === "legacy-allowed") {
        expect(result).toBe("admitted");
        expect(consumed).toHaveBeenCalledOnce();
      } else {
        expect(result).toBeInstanceOf(Error);
        expect(consumed).not.toHaveBeenCalled();
      }
      expect(compatAssertCurrent).toHaveBeenCalledTimes(
        change === "partial" || change === "compat-refusal" || change === "legacy-allowed" ? 1 : 0,
      );
      expect(onRefused).toHaveBeenCalledTimes(
        change === "refusal" || change === "compat-refusal" ? 1 : 0,
      );
    } finally {
      resume.resolve();
      await outcome;
      calls.restore();
      delayed.mockRestore();
    }
  });
});

it("pins the native lineage database before tool preparation yields", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:lineage-source";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "same", updatedAt: 1 },
    );
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
    const authority = createNativeSessionBindingAuthority(
      [
        {
          read: { agentId: "main", sessionKey, storePath, env: state.env },
          sessionId: "same",
          createSupersededError: () => new Error("superseded"),
        },
      ],
      () => {},
    );
    const entered = createDeferred();
    const resume = createDeferred();
    const consumed = vi.fn();
    const outcome = authority.withPreparedCurrent!(consumed, [
      {
        assertCurrent() {},
        compatAssertCurrent() {},
        async prepareCurrent() {
          entered.resolve();
          await resume.promise;
        },
      },
    ]).catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        outcome,
        "Policy preparation was not reached",
      );
      copyFileSync(storePath, `${storePath}.replacement`);
      renameSync(`${storePath}.replacement`, storePath);
      resume.resolve();
      expect(await outcome).toMatchObject({
        message: "Native session lineage source changed during tool preparation",
      });
      expect(consumed).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await outcome;
    }
  });
});
