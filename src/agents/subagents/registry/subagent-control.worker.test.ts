// Preserve the real registry fixture before importing its runtime consumers.
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture } from "./subagent-control.test-support.js";
import { existsSync } from "node:fs";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as sqlite from "../../../../test/helpers/sqlite-parent-observer.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import * as pluginHooks from "../../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import * as lifecycle from "../../../sessions/session-controller.lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import * as embedded from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { createOpenClawToolsAsync } from "../../openclaw-tools.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import {
  createSubagentRunParams,
  createSubagentRunRecord,
  isSubagentRegistryWriteCommand,
} from "../../subagent-test-fixtures.test-helpers.js";
import { resolveStoredSubagentCapabilities } from "../spawn/subagent-capabilities.js";
import { withPreparedSessionCapabilityRead } from "../spawn/subagent-session-store.js";
import { holdQueuedSwarmRun, releaseSwarmRun, reserveSwarmRun } from "../swarm/swarm-scheduler.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import * as registryState from "./subagent-registry-state.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";

const fixture = useSubagentControlFixture();
beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
});
function seedSession(sessionKey: string, entry: Partial<SessionEntry> = {}, agentId = "main") {
  replaceSessionEntrySync(
    { agentId, sessionKey },
    { sessionId: `${sessionKey.split(":").at(-1)}-session`, updatedAt: Date.now(), ...entry },
  );
}

function observeWrites(
  runId: string,
  hooks: {
    before?: (row: ReturnType<typeof rowToSubagentRunRecord>) => void | Promise<void>;
    after?: (row: ReturnType<typeof rowToSubagentRunRecord>) => void;
  },
) {
  fixture.worker.mockImplementation((context, operation, options) =>
    runSubagentStateWorkerOperation(
      context,
      (scope) =>
        operation({
          execute: async (command, commandOptions) => {
            const value = isSubagentRegistryWriteCommand(command)
              ? command.input.values.find((candidate) => candidate.run_id === runId)
              : undefined;
            const row = value ? rowToSubagentRunRecord(value) : null;
            const gate = hooks.before?.(row);
            if (gate) {
              await gate;
            }
            const receipt = await scope.execute(command, commandOptions);
            hooks.after?.(row);
            return receipt;
          },
        }),
      options,
    ),
  );
}
function registration(runId: string, sessionKey: string, task = "original") {
  return createSubagentRunParams({
    runId,
    childSessionKey: sessionKey,
    sessionEntry: loadExactSessionEntryReadOnly({ agentId: "main", sessionKey })?.entry,
    requesterAgentId: "main",
    task,
    expectsCompletionMessage: false,
  });
}
async function subagentsTool(config = getRuntimeConfig(), agentSessionKey = "agent:main:main") {
  const tool = (
    await createOpenClawToolsAsync({
      config,
      agentSessionKey,
      workspaceDir: fixture.stateDir,
      disableMessageTool: true,
    })
  ).find((candidate) => candidate.name === "subagents");
  if (!tool) {
    throw new Error("Missing registered subagents tool");
  }
  return tool;
}

// Native fixture handles must remain attached to their admitted controller turn until cleanup.
async function admitNativeRun(runId: string, sessionKey: string, detachOnAbort = true) {
  const sessionId = `${runId}-session`;
  const abort = vi.fn(() => {
    if (detachOnAbort) {
      embedded.detachActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
  });
  const handle = createEmbeddedRunHandle({ runId, abort });
  const admitted = createDeferred();
  const release = createDeferred();
  const originalAbort = handle.abort;
  handle.abort = (...args) => {
    try {
      originalAbort(...args);
    } finally {
      release.resolve();
    }
  };
  const settlement = withSessionTurn(
    { sessionKey, sessionId, agentId: "main" },
    async (operation) => {
      if (!operation) {
        throw new Error("Native fixture did not receive controller turn admission");
      }
      embedded.attachActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "main", operation);
      admitted.resolve();
      await release.promise;
    },
  );
  await Promise.race([admitted.promise, settlement]);
  return {
    id: runId,
    abort,
    finish: async () => {
      embedded.detachActiveEmbeddedRun(sessionId, handle, sessionKey);
      release.resolve();
      await settlement;
    },
  };
}

it.each(["caller admission", "session generation"] as const)(
  "releases an acknowledged native claim when %s retires before publication",
  async (retirement) => {
    const runId = "retired-after-claim-ack";
    const sessionKey = `agent:main:subagent:${runId}`;
    const sessionId = `${runId}-session`;
    seedSession(sessionKey, { lifecycleRevision: "original" });
    await registerSubagentRun(registration(runId, sessionKey, "Stop admitted work"));
    const caller = new AbortController();
    const nativeRun = await admitNativeRun(runId, sessionKey, false);
    const { abort } = nativeRun;
    let retiredAfterAck = false;
    observeWrites(runId, {
      after: (row) => {
        if (!row?.killIntent || retiredAfterAck) {
          return;
        }
        retiredAfterAck = true;
        if (retirement === "caller admission") {
          caller.abort(new Error("Caller retired after commit"));
        } else {
          seedSession(sessionKey, { lifecycleRevision: "replacement" });
        }
      },
    });
    const tool = await subagentsTool();
    // The session-rotation cell deliberately writes through the native fixture owner.
    const sql = retirement === "caller admission" ? observeMainThreadSql() : undefined;
    sql?.calibrate();
    let counts: number[] | undefined;
    try {
      const cancellation = tool.execute(
        "retired-caller-stop",
        { action: "cancel", runId },
        caller.signal,
      );
      if (retirement === "caller admission") {
        await expect(cancellation).rejects.toThrow("Caller retired after commit");
      } else {
        expect((await cancellation).details).toMatchObject({ found: true, killed: false });
      }
      await fixture.settle();
    } finally {
      counts = sql?.calls.map((probe) => probe.mock.calls.length);
      sql?.restore();
      await nativeRun.finish();
    }
    expect(retiredAfterAck).toBe(true);
    expect(abort).not.toHaveBeenCalled();
    const persisted = loadSubagentRegistryFromSqlite().get(runId);
    expect([persisted?.killIntent, persisted?.execution.endedAt]).toEqual([undefined, undefined]);
    if (counts) {
      expect(counts).toEqual(counts.map(() => 0));
    } else {
      const entry = loadExactSessionEntryReadOnly({ agentId: "main", sessionKey })?.entry;
      expect(entry).toMatchObject({
        sessionId,
        lifecycleRevision: "replacement",
      });
      expect(entry?.abortedLastRun).not.toBe(true);
    }
  },
);

it.each(["same-ID replacement", "cold hydration"] as const)(
  "preserves registered Stop selection across %s",
  async (kind) => {
    await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
      const runId = "replace-during-control-preparation";
      const sessionKey = `agent:main:subagent:${runId}`;
      seedSession(sessionKey, { lifecycleRevision: "same-session" });
      const originalRegistration = registration(runId, sessionKey);
      await registerSubagentRun(originalRegistration);
      const original = subagentRuns.get(runId)!;
      if (kind === "cold hydration") {
        subagentRuns.clear();
      }
      const tool = await subagentsTool();
      registryState.clearSubagentRunsReadCacheForTest();
      const entered = createDeferred();
      const release = createDeferred();
      const prepareReadCache = registryState.prepareSubagentSessionListReadCache;
      vi.spyOn(registryState, "prepareSubagentSessionListReadCache").mockImplementationOnce(
        async () => {
          entered.resolve();
          await release.promise;
          await prepareReadCache();
        },
      );
      const pending = tool
        .execute("prepared-stop", { action: "cancel", runId })
        .catch((error: unknown) => error);
      let nativeRun: Awaited<ReturnType<typeof admitNativeRun>> | undefined;
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Stop skipped control preparation");
          }),
        ]);
        if (kind === "same-ID replacement") {
          await registerSubagentRun({ ...originalRegistration, task: "successor" });
        } else {
          // The existing startup owner hydrates the persisted row; this is not an absence witness.
          expect(await restoreSubagentRunsFromDisk({ runs: subagentRuns })).toBeGreaterThan(0);
        }
        const successor = subagentRuns.get(runId)!;
        expect(successor).not.toBe(original);
        if (kind === "same-ID replacement") {
          expect(successor.generation).toBeGreaterThan(original.generation!);
        } else {
          expect(successor.generation).toBe(original.generation);
        }
        nativeRun = await admitNativeRun(runId, sessionKey);
        const { abort } = nativeRun;
        release.resolve();
        const outcome = await pending;
        await fixture.settle();
        if (kind === "same-ID replacement") {
          expect(abort, "Stop must not transfer to newly registered work").not.toHaveBeenCalled();
          expect(outcome).toBeInstanceOf(Error);
          expect(subagentRuns.get(runId)?.execution.endedAt).toBeUndefined();
        } else {
          expect(outcome).toMatchObject({ details: { found: true, killed: true } });
          expect(abort).toHaveBeenCalledOnce();
          expect(loadSubagentRegistryFromSqlite().get(runId)?.endedReason).toBe("subagent-killed");
        }
      } finally {
        release.resolve();
        await pending;
        await nativeRun?.finish();
      }
    });
  },
);

it.each([
  "active",
  "queued",
  "queued without child store",
  "completion",
  "subagent caller",
  "subagent caller with opaque id",
  "subagent caller with cross-agent key",
  "earlier success",
] as const)("settles registered runId Stop for an %s native child", async (kind) =>
  withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
    const runId = `native-run-stop-${kind.replaceAll(" ", "-")}`;
    const siblingId = `${runId}-untouched`;
    const missingStore = kind === "queued without child store";
    const queued = kind === "queued" || missingStore;
    const missingPath = resolveOpenClawAgentSqlitePath({ agentId: "missing" });
    const key = (id: string) =>
      `agent:${missingStore && id === runId ? "missing" : "main"}:subagent:${id}`;
    const capacityOwner = `${runId}-capacity`;
    const subagentCaller = kind.startsWith("subagent caller");
    const opaqueParentId = kind === "subagent caller with opaque id";
    const keyedParent = kind === "subagent caller with cross-agent key";
    const earlierSuccess = kind === "earlier success";
    const completesDuringStop = kind === "completion" || earlierSuccess;
    const fixtureStartedAt = Date.now();
    const clock = earlierSuccess
      ? vi.spyOn(Date, "now").mockReturnValue(fixtureStartedAt)
      : undefined;
    if (clock) {
      onTestFinished(() => clock.mockRestore());
    }
    const endedHook = vi.fn(async () => {});
    if (earlierSuccess) {
      const registry = createMockPluginRegistry([
        { hookName: "subagent_ended", handler: endedHook },
      ]);
      vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(registry);
      pluginHooks.initializeGlobalHookRunner(registry);
      onTestFinished(pluginHooks.resetGlobalHookRunner);
      fixture.capture.mockResolvedValue("Completed before Stop");
    }
    const requester = subagentCaller ? "agent:main:subagent:controller" : "agent:main:main";
    const config = structuredClone(getRuntimeConfig());
    if (subagentCaller) {
      const parentId = `agent:${opaqueParentId ? "other" : "main"}:subagent:parent-by-session-id`;
      const parentAgentId = keyedParent ? "other" : "main";
      const parentKey = `agent:${parentAgentId}:controller-parent`;
      config.agents ??= {};
      config.agents.defaults ??= {};
      config.agents.defaults.subagents = {
        ...config.agents.defaults.subagents,
        maxSpawnDepth: 2,
      };
      seedSession(requester, {
        sessionId: "controller-session",
        lifecycleRevision: "controller-original",
        spawnedBy: keyedParent ? parentKey : parentId,
      });
      seedSession(
        parentKey,
        {
          sessionId: keyedParent ? "controller-parent-session" : parentId,
          spawnDepth: 0,
        },
        parentAgentId,
      );
      if (opaqueParentId) {
        seedSession(
          "agent:other:controller-decoy",
          { sessionId: parentId, spawnDepth: 7 },
          "other",
        );
      }
      expect(
        await withPreparedSessionCapabilityRead(() =>
          resolveStoredSubagentCapabilities(requester, { cfg: config, agentId: "main" }),
        ),
      ).toMatchObject({ controlScope: "children" });
    }
    const terminalEntered = createDeferred();
    const terminalRelease = createDeferred();
    let heldTerminal = false;
    let admission: lifecycle.SessionEffectRef | undefined;
    let runnerSettlement: Promise<void> | undefined;
    if (completesDuringStop) {
      observeWrites(runId, {
        before: (row) => {
          if (!heldTerminal && row?.execution.status === "terminal") {
            heldTerminal = true;
            terminalEntered.resolve();
            return terminalRelease.promise;
          }
        },
      });
    }
    if (queued) {
      expect(
        reserveSwarmRun({
          runId,
          groupId: runId,
          maxConcurrent: 1,
          activeRunIds: [capacityOwner],
        }),
      ).toBe(true);
    }
    for (const id of [runId, siblingId]) {
      if (missingStore && id === runId) {
        const retained = createSubagentRunRecord({
          runId: id,
          childSessionKey: key(id),
          childAgentId: "missing",
          childSessionIdentity: undefined,
          requesterSessionKey: requester,
          requesterAgentId: "main",
          execution: { status: "queued" },
          collect: true,
          expectsCompletionMessage: false,
        });
        await mutateSubagentRuns([id], () => ({
          value: undefined,
          postimages: new Map([[id, retained]]),
        }));
        continue;
      }
      seedSession(key(id), {
        lifecycleRevision: `${id}-revision`,
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      });
      await registerSubagentRun({
        ...registration(id, key(id), id),
        requesterSessionKey: requester,
        collect: queued && id === runId,
        queued: queued && id === runId,
      });
    }
    if (missingStore) {
      expect(existsSync(missingPath)).toBe(false);
    }
    const handles: Awaited<ReturnType<typeof admitNativeRun>>[] = [];
    for (const id of [runId, siblingId].filter((candidate) => !queued || candidate !== runId)) {
      handles.push(await admitNativeRun(id, key(id)));
    }
    const tool = await subagentsTool(config, requester);
    const completedAtBeforeStop = earlierSuccess ? fixtureStartedAt + 1 : Date.now();
    clock?.mockReturnValue(fixtureStartedAt + 2);
    if (completesDuringStop) {
      admission = await lifecycle.beginSessionEffect({
        scope: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
          agentId: "main",
        }),
        identities: [key(runId), `${runId}-session`],
        run: { runId, sessionKey: key(runId), sessionId: `${runId}-session`, agentId: "main" },
        assertAllowed: () => {},
        onInterrupt: () => {
          handles.find(({ id }) => id === runId)!.abort();
          if (earlierSuccess) {
            expect(subagentRuns.get(runId)?.killIntent?.requestedAt).toBeGreaterThan(
              completedAtBeforeStop,
            );
          }
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: earlierSuccess
              ? {
                  phase: "end",
                  status: "ok",
                  endedAt: completedAtBeforeStop,
                  terminalReply: { disposition: "visible", text: "Completed before Stop" },
                }
              : { phase: "end", status: "error", aborted: true, endedAt: Date.now() },
          });
          runnerSettlement = fixture.settle().finally(() => admission?.release());
          return { runId };
        },
      });
    }
    await fixture.settle();
    registryState.clearSubagentRunsReadCacheForTest();
    // Warm initialization ends here. Count all eight host APIs through Stop and
    // its owned settlement; independent durable readbacks begin after restore.
    const sql = sqlite.observeParentSqlite();
    let counts: ReturnType<typeof sqlite.emptySqliteCounts>;
    let unexpectedHold: ReturnType<typeof holdQueuedSwarmRun>;
    let cancellation: ReturnType<typeof tool.execute> | undefined;
    try {
      let settled = false;
      cancellation = tool
        .execute("registered-native-stop", { action: "cancel", runId })
        .then((result) => {
          settled = true;
          return result;
        });
      if (completesDuringStop) {
        await Promise.race([
          terminalEntered.promise,
          cancellation.then(() => {
            throw new Error("Stop settled before its terminal writer was admitted");
          }),
        ]);
        expect(settled, "Stop joins the runner's held terminal publication").toBe(false);
        terminalRelease.resolve();
      }
      const result = await cancellation;
      expect(result.details, JSON.stringify(result.details)).toMatchObject({
        found: true,
        killed: !earlierSuccess,
        runId,
        ...(earlierSuccess ? { targetState: { task: { status: "succeeded" } } } : {}),
      });
      await fixture.settle();
      await runnerSettlement;
    } finally {
      terminalRelease.resolve();
      admission?.release();
      await Promise.allSettled([runnerSettlement, cancellation]);
      counts = { ...sql.counts };
      sql.restore();
      if (earlierSuccess) {
        pluginHooks.resetGlobalHookRunner();
      }
      await Promise.all(handles.map((nativeRun) => nativeRun.finish()));
      releaseSwarmRun(capacityOwner);
      if (missingStore) {
        expect
          .soft(existsSync(missingPath), "Stop must not provision the missing child store")
          .toBe(false);
      }
    }
    try {
      const persisted = loadSubagentRegistryFromSqlite();
      const target = persisted.get(runId);
      if (missingStore) {
        expect(target?.childSessionIdentity).toBeUndefined();
        expect(target).toMatchObject({ execution: { suppressSessionEffects: true } });
      }
      expect(target).toMatchObject({
        execution: { status: "terminal" },
        endedReason: earlierSuccess ? "subagent-complete" : "subagent-killed",
      });
      expect(persisted.get(siblingId)?.execution.endedAt).toBeUndefined();
      const entry = !missingStore
        ? loadExactSessionEntryReadOnly({ agentId: "main", sessionKey: key(runId) })?.entry
        : undefined;
      if (!missingStore) {
        expect(entry).toMatchObject({
          ...(earlierSuccess
            ? { status: "done" }
            : kind === "completion"
              ? { status: "killed" }
              : { abortedLastRun: true }),
          endedAt: expect.any(Number),
        });
      }
      expect(handles.find(({ id }) => id === siblingId)?.abort).not.toHaveBeenCalled();
      if (!queued) {
        expect(handles.find(({ id }) => id === runId)?.abort).toHaveBeenCalledOnce();
      } else {
        unexpectedHold = holdQueuedSwarmRun(runId);
        expect(unexpectedHold).toBeUndefined();
        if (!missingStore) {
          expect(target?.collectorCompletion?.usage).toMatchObject({
            inputTokens: 11,
            outputTokens: 7,
          });
        }
      }
      if (earlierSuccess) {
        expect(target).toMatchObject({
          execution: { outcome: { status: "ok" } },
          endedHookEmittedAt: expect.any(Number),
          completion: { resultText: "Completed before Stop" },
        });
        expect(endedHook).toHaveBeenCalledOnce();
        expect(entry?.abortedLastRun).not.toBe(true);
      }
      expect(counts).toEqual(sqlite.emptySqliteCounts());
    } finally {
      await unexpectedHold?.release();
    }
  }),
);
