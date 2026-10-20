// Preserve the real registry fixture before importing its runtime consumers.
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture } from "./subagent-control.test-support.js";
import { existsSync } from "node:fs";
import { assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import * as sync from "../../../../test/helpers/promise.js";
import * as sqlite from "../../../../test/helpers/sqlite-parent-observer.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import * as sessions from "../../../config/sessions/session-accessor.js";
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
import * as records from "../../subagent-test-fixtures.test-helpers.js";
import { resolveStoredSubagentCapabilities } from "../spawn/subagent-capabilities.js";
import { withPreparedSessionCapabilityRead } from "../spawn/subagent-session-store.js";
import { holdQueuedSwarmRun, releaseSwarmRun, reserveSwarmRun } from "../swarm/swarm-scheduler.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import * as persistence from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import * as registryState from "./subagent-registry-state.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";

const fixture = useSubagentControlFixture();
beforeEach(() => captureRuntimeConfigAsyncReader()());
function seedSession(sessionKey: string, entry: Partial<SessionEntry> = {}, agentId = "main") {
  sessions.replaceSessionEntrySync(
    { agentId, sessionKey },
    { sessionId: `${sessionKey.split(":").at(-1)}-session`, updatedAt: Date.now(), ...entry },
  );
}

type WriteHook = (row: ReturnType<typeof rowToSubagentRunRecord>) => void | Promise<void>;
type Hooks = { before?: WriteHook; after?: (row: Parameters<WriteHook>[0]) => void };
function observeWrites(runId: string, hooks: Hooks) {
  fixture.worker.mockImplementation((context, operation, options) =>
    runSubagentStateWorkerOperation(
      context,
      (scope) =>
        operation({
          execute: async (command, commandOptions) => {
            const value = records.isSubagentRegistryWriteCommand(command)
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
  return records.createSubagentRunParams({
    runId,
    childSessionKey: sessionKey,
    sessionEntry: sessions.loadExactSessionEntryReadOnly({ agentId: "main", sessionKey })?.entry,
    requesterAgentId: "main",
    task,
    expectsCompletionMessage: false,
  });
}
async function subagentsTool(config = getRuntimeConfig(), agentSessionKey = "agent:main:main") {
  const tools = await createOpenClawToolsAsync({
    config,
    agentSessionKey,
    workspaceDir: fixture.stateDir,
    disableMessageTool: true,
  });
  const tool = tools.find((candidate) => candidate.name === "subagents");
  assert(tool, "Missing registered subagents tool");
  return tool;
}

// Native fixture handles must remain attached to their admitted controller turn until cleanup.
async function admitNativeRun(runId: string, sessionKey: string, detachOnAbort = true) {
  const sessionId = `${runId}-session`;
  const admitted = sync.createDeferred();
  const release = sync.createDeferred();
  const abort = vi.fn(() => {
    if (detachOnAbort) {
      embedded.detachActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
  });
  const handle = createEmbeddedRunHandle({ runId, abort });
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
      assert(operation, "Native fixture did not receive controller turn admission");
      embedded.attachActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "main", operation);
      admitted.resolve();
      await release.promise;
    },
  );
  await Promise.race([admitted.promise, settlement]);
  const finish = async () => {
    embedded.detachActiveEmbeddedRun(sessionId, handle, sessionKey);
    release.resolve();
    await settlement;
  };
  return { id: runId, abort, finish };
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
    let retiredAfterAck = false;
    observeWrites(runId, {
      after: (row) => {
        if (row?.killIntent && !retiredAfterAck) {
          retiredAfterAck = true;
          if (retirement === "caller admission") {
            caller.abort(new Error("Caller retired after commit"));
          } else {
            seedSession(sessionKey, { lifecycleRevision: "replacement" });
          }
        }
      },
    });
    const tool = await subagentsTool();
    // The session-rotation cell deliberately writes through the native fixture owner.
    const sql = retirement === "caller admission" ? observeMainThreadSql() : undefined;
    sql?.calibrate();
    let counts: number[] | undefined;
    try {
      const cancellation = tool.execute("stop", { action: "cancel", runId }, caller.signal);
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
    expect(nativeRun.abort).not.toHaveBeenCalled();
    const persisted = loadSubagentRegistryFromSqlite().get(runId);
    expect([persisted?.killIntent, persisted?.execution.endedAt]).toEqual([undefined, undefined]);
    if (counts) {
      expect(counts).toEqual(counts.map(() => 0));
    } else {
      const entry = sessions.loadExactSessionEntryReadOnly({ agentId: "main", sessionKey })?.entry;
      expect(entry).toMatchObject({ sessionId, lifecycleRevision: "replacement" });
      expect(entry?.abortedLastRun).not.toBe(true);
    }
  },
);

it.each(["same-ID replacement", "cold hydration"] as const)(
  "preserves registered Stop selection across %s",
  async (kind) =>
    withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
      const runId = "replace-during-control-preparation";
      const sessionKey = `agent:main:subagent:${runId}`;
      seedSession(sessionKey, { lifecycleRevision: "same-session" });
      const params = registration(runId, sessionKey);
      await registerSubagentRun(params);
      const original = subagentRuns.get(runId)!;
      if (kind === "cold hydration") {
        subagentRuns.clear();
      }
      const tool = await subagentsTool();
      registryState.clearSubagentRunsReadCacheForTest();
      const entered = sync.createDeferred();
      const release = sync.createDeferred();
      const prepareReadCache = registryState.prepareSubagentSessionListReadCache;
      vi.spyOn(registryState, "prepareSubagentSessionListReadCache").mockImplementationOnce(
        async () => {
          entered.resolve();
          await release.promise;
          await prepareReadCache();
        },
      );
      const pending = tool
        .execute("stop", { action: "cancel", runId })
        .catch((error: unknown) => error);
      let nativeRun: Awaited<ReturnType<typeof admitNativeRun>> | undefined;
      try {
        await sync.awaitGateBeforeSettlement(entered.promise, pending, "Stop skipped preparation");
        if (kind === "same-ID replacement") {
          await registerSubagentRun({ ...params, task: "successor" });
        } else {
          // The existing startup owner hydrates the persisted row; this is not an absence witness.
          expect(
            await persistence.restoreSubagentRunsFromDisk({ runs: subagentRuns }),
          ).toBeGreaterThan(0);
        }
        const successor = subagentRuns.get(runId)!;
        expect(successor).not.toBe(original);
        if (kind === "same-ID replacement") {
          expect(successor.generation).toBeGreaterThan(original.generation!);
        } else {
          expect(successor.generation).toBe(original.generation);
        }
        nativeRun = await admitNativeRun(runId, sessionKey);
        release.resolve();
        const outcome = await pending;
        await fixture.settle();
        if (kind === "same-ID replacement") {
          expect(nativeRun.abort).not.toHaveBeenCalled();
          expect(outcome).toBeInstanceOf(Error);
          expect(subagentRuns.get(runId)?.execution.endedAt).toBeUndefined();
        } else {
          expect(outcome).toMatchObject({ details: { found: true, killed: true } });
          expect(nativeRun.abort).toHaveBeenCalledOnce();
          expect(loadSubagentRegistryFromSqlite().get(runId)?.endedReason).toBe("subagent-killed");
        }
      } finally {
        release.resolve();
        await pending;
        await nativeRun?.finish();
      }
    }),
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
    const terminalRace = kind === "completion" || earlierSuccess;
    const startedAt = Date.now();
    const clock = earlierSuccess ? vi.spyOn(Date, "now").mockReturnValue(startedAt) : undefined;
    onTestFinished(() => clock?.mockRestore());
    const endedHook = vi.fn(async () => {});
    const reply = { disposition: "visible", text: "Completed before Stop" };
    if (earlierSuccess) {
      const hook = { hookName: "subagent_ended", handler: endedHook };
      const registry = createMockPluginRegistry([hook]);
      vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(registry);
      pluginHooks.initializeGlobalHookRunner(registry);
      onTestFinished(pluginHooks.resetGlobalHookRunner);
      fixture.capture.mockResolvedValue(reply.text);
    }
    const requester = subagentCaller ? "agent:main:subagent:controller" : "agent:main:main";
    const config = structuredClone(getRuntimeConfig());
    if (subagentCaller) {
      const parentId = `agent:${opaqueParentId ? "other" : "main"}:subagent:parent-by-session-id`;
      const parentAgentId = keyedParent ? "other" : "main";
      const parentKey = `agent:${parentAgentId}:controller-parent`;
      config.agents ??= {};
      config.agents.defaults ??= {};
      config.agents.defaults.subagents = { ...config.agents.defaults.subagents, maxSpawnDepth: 2 };
      seedSession(requester, {
        sessionId: "controller-session",
        lifecycleRevision: "controller-original",
        spawnedBy: keyedParent ? parentKey : parentId,
      });
      const parent = { sessionId: keyedParent ? "parent-session" : parentId, spawnDepth: 0 };
      seedSession(parentKey, parent, parentAgentId);
      if (opaqueParentId) {
        const decoy = { sessionId: parentId, spawnDepth: 7 };
        seedSession("agent:other:controller-decoy", decoy, "other");
      }
      expect(
        await withPreparedSessionCapabilityRead(() =>
          resolveStoredSubagentCapabilities(requester, { cfg: config, agentId: "main" }),
        ),
      ).toMatchObject({ controlScope: "children" });
    }
    const entered = sync.createDeferred();
    const release = sync.createDeferred();
    let heldTerminal = false;
    let admission: lifecycle.SessionEffectRef | undefined;
    let runnerSettlement: Promise<void> | undefined;
    if (terminalRace) {
      observeWrites(runId, {
        before: (row) => {
          if (!heldTerminal && row?.execution.status === "terminal") {
            heldTerminal = true;
            entered.resolve();
            return release.promise;
          }
          return undefined;
        },
      });
    }
    if (queued) {
      const capacity = { runId, groupId: runId, maxConcurrent: 1, activeRunIds: [capacityOwner] };
      expect(reserveSwarmRun(capacity)).toBe(true);
    }
    for (const id of [runId, siblingId]) {
      if (missingStore && id === runId) {
        const retained = records.createSubagentRunRecord({
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
        await persistence.mutateSubagentRuns([id], () => ({
          value: undefined,
          postimages: new Map([[id, retained]]),
        }));
        continue;
      }
      const usage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
      seedSession(key(id), { lifecycleRevision: `${id}-revision`, ...usage });
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
    const completedAt = earlierSuccess ? startedAt + 1 : Date.now();
    const completed = { status: "ok", endedAt: completedAt, terminalReply: reply };
    clock?.mockReturnValue(startedAt + 2);
    if (terminalRace) {
      admission = await lifecycle.beginSessionEffect({
        scope: resolveSessionStorePathCore(config.session?.store, { agentId: "main" }),
        identities: [key(runId), `${runId}-session`],
        run: { runId, sessionKey: key(runId), sessionId: `${runId}-session`, agentId: "main" },
        assertAllowed: () => {},
        onInterrupt: () => {
          handles.find(({ id }) => id === runId)!.abort();
          if (earlierSuccess) {
            expect(subagentRuns.get(runId)?.killIntent?.requestedAt).toBeGreaterThan(completedAt);
          }
          const terminal = earlierSuccess
            ? completed
            : { status: "error", aborted: true, endedAt: Date.now() };
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", ...terminal } });
          runnerSettlement = fixture.settle().finally(() => admission?.release());
          return { runId };
        },
      });
    }
    await fixture.settle();
    registryState.clearSubagentRunsReadCacheForTest();
    // Observe host APIs through Stop settlement; restore before independent durable readbacks.
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
      if (terminalRace) {
        await sync.awaitGateBeforeSettlement(
          entered.promise,
          cancellation,
          "Stop skipped terminal write",
        );
        expect(settled, "Stop joins the runner's held terminal publication").toBe(false);
        release.resolve();
      }
      const result = await cancellation;
      expect(result.details).toMatchObject({ found: true, killed: !earlierSuccess, runId });
      if (earlierSuccess) {
        expect(result.details).toMatchObject({ targetState: { task: { status: "succeeded" } } });
      }
      await fixture.settle();
      await runnerSettlement;
    } finally {
      release.resolve();
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
        const provisioned = existsSync(missingPath);
        expect.soft(provisioned, "Stop created the missing child store").toBe(false);
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
        ? sessions.loadExactSessionEntryReadOnly({ agentId: "main", sessionKey: key(runId) })?.entry
        : undefined;
      if (!missingStore) {
        const status = earlierSuccess ? "done" : kind === "completion" ? "killed" : undefined;
        expect(entry).toMatchObject({
          ...(status ? { status } : { abortedLastRun: true }),
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
          completion: { resultText: reply.text },
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
