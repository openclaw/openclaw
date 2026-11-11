// Preserve the real registry fixture before importing its runtime consumers.
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture } from "./subagent-control.test-support.js";
import { existsSync } from "node:fs";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from "vitest";
import * as sync from "../../../../test/helpers/promise.js";
import * as sqlite from "../../../../test/helpers/sqlite-parent-observer.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import * as sessions from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { abortControlledSubagents } from "../../../gateway/server-methods/chat-abort-descendants.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { resetSystemEventsForTest } from "../../../infra/system-events.js";
import * as pluginHooks from "../../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import * as lifecycle from "../../../sessions/session-controller.lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import * as embedded from "../../embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as detachRun,
  registerTestEmbeddedRun as attachRun,
  createEmbeddedRunHandle,
} from "../../embedded-agent-runner/runs.test-support.js";
import { createOpenClawToolsAsync } from "../../openclaw-tools.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import * as records from "../../subagent-test-fixtures.test-helpers.js";
import {
  setSubagentAnnounceDeliveryDepsForTest,
  type SubagentAnnounceDeliveryTestDeps,
} from "../announce/subagent-announce-overrides.test-support.js";
import { resolveStoredSubagentCapabilities } from "../spawn/subagent-capabilities.js";
import { withPreparedSessionCapabilityRead } from "../spawn/subagent-session-store.js";
import { holdQueuedSwarmRun, releaseSwarmRun, reserveSwarmRun } from "../swarm/swarm-scheduler.js";
import { killSessionSubagentRuns } from "./subagent-control-kill.js";
import { adoptSubagentProgressDraft } from "./subagent-progress-draft.js";
import {
  childKey,
  requesterKey,
  useSubagentProgressCohort,
} from "./subagent-progress-draft.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import * as persistence from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import * as registryState from "./subagent-registry-state.js";
import { adoptPausedSubagentRunForFollowUp, registerSubagentRun } from "./subagent-registry.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { testing as registryTesting } from "./subagent-registry.test-helpers.js";

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

describe("subagent progress drafts", () => {
  const yieldCohort = useSubagentProgressCohort(fixture);

  const CHILD_RESULT = "Private child result marker.";
  const DONE = "Done.";
  const stops = { killSessionSubagentRuns, abortControlledSubagents };

  type Dispatch = SubagentAnnounceDeliveryTestDeps["dispatchGatewayMethodInProcess"];
  type DispatchParams = Parameters<Dispatch>[1];

  afterEach(() => {
    setSubagentAnnounceDeliveryDepsForTest();
    resetSystemEventsForTest();
  });

  async function endRun(runId: string, data: Record<string, unknown> = {}) {
    fixture.capture.mockResolvedValue(CHILD_RESULT);
    emitAgentEvent({
      runId,
      sessionKey: subagentRuns.get(runId)!.childSessionKey,
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text: CHILD_RESULT },
        ...data,
      },
    });
    await fixture.settle();
  }

  /** Each requester wake turn answers with the next reply; `onWake` runs inside that turn. */
  function answerWakes(
    draft: TestDraft,
    replies: readonly string[],
    onWake?: (params: DispatchParams) => Promise<void>,
  ) {
    const wakes: Array<{ runId: string; retiredBefore: number }> = [];
    const dispatch: Dispatch = async <T>(...args: Parameters<Dispatch>): Promise<T> => {
      const [, params, options] = args;
      wakes.push({
        runId: String(params?.idempotencyKey),
        retiredBefore: draft.retire.mock.calls.length,
      });
      options?.onExecutionStarted?.();
      if (wakes.length === 1) {
        await onWake?.(params);
      }
      const terminal = prepareAgentRunTerminalReply({ rawText: replies[wakes.length - 1] ?? "" });
      return {
        status: "ok",
        inputProcessingCompleted: true,
        result: {
          payloads: terminal.text ? [{ text: terminal.text }] : [],
          meta: { terminalReply: terminal.terminalReply },
          ...(terminal.terminalReply.disposition === "silent" && {
            deliveryStatus: {
              status: "suppressed",
              succeeded: true,
              reason: "no_visible_payload",
              resultCount: 0,
            },
          }),
        },
      } as T;
    };
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
    return wakes;
  }

  type TestDraft = { push: Mock; retire: Mock };
  const newDraft = (): TestDraft => ({ push: vi.fn(), retire: vi.fn() });

  it("keeps progress titles whole at the 120-unit UTF-16 bound", async () => {
    const prefix = "a".repeat(119);
    const spawns = await yieldCohort("parent-turn", ["a"], undefined, { a: `${prefix}😀tail` });
    const draft = newDraft();
    expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
    expect(draft.push).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "a", kind: "subagent", title: prefix }),
    );
  });

  async function adoptCohort(children = ["a", "b"], origin?: Parameters<typeof yieldCohort>[2]) {
    const spawns = await yieldCohort("parent-turn", children, origin);
    const draft = newDraft();
    expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
    return draft;
  }

  const stopParams = () => ({ cfg: getRuntimeConfig(), sessionKey: requesterKey, agentId: "main" });
  const storePath = () =>
    resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId: "main" });

  function expectCard(draft: TestDraft, retireCount = 1) {
    expect(draft.retire).toHaveBeenCalledTimes(retireCount);
    expect(JSON.stringify(draft.push.mock.calls)).not.toContain(CHILD_RESULT);
  }

  it.each([
    ["a visible answer", DONE, false],
    ["external NO_REPLY", "NO_REPLY", true],
    ["internal NO_REPLY", "NO_REPLY", false],
    ["external empty reply", "", true],
    ["internal empty reply", "", false],
  ] as const)("settles the progress card once after %s", async (_name, reply, external) => {
    const requesterOrigin = external
      ? { channel: "telegram", to: "12345", accountId: "default" }
      : undefined;
    if (requesterOrigin) {
      const { channel, to, accountId } = requesterOrigin;
      await sessions.upsertSessionEntryCore(
        { storePath: storePath(), sessionKey: requesterKey },
        {
          delivery: {
            kind: "external",
            route: { channel, accountId, target: { to } },
            context: requesterOrigin,
            origin: { provider: channel, to, accountId },
          },
        },
      );
    }
    const draft = await adoptCohort(["a", "b"], requesterOrigin);
    const wakes = answerWakes(draft, [reply]);

    await endRun("a");
    expect(wakes).toEqual([]);
    expect(draft.retire).not.toHaveBeenCalled();

    await endRun("b");
    expect(wakes).toEqual([{ runId: expect.any(String), retiredBefore: 0 }]);
    expectCard(draft);
    const persisted = loadSubagentRegistryFromSqlite();
    for (const runId of ["a", "b"]) {
      const entry = persisted.get(runId);
      expect(entry?.requesterSettleWake).toBeUndefined();
      expect(entry).toMatchObject({
        delivery: { status: "delivered" },
        completion: { resultText: CHILD_RESULT },
      });
    }
    expect(draft.push).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "b", kind: "subagent", status: "completed" }),
    );
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(Date.now() + 120_000);
    await registryTesting.sweepOnceForTests();
    await fixture.settle();
    expect(wakes).toHaveLength(1);
    expectCard(draft);
  });

  it("rejects a delivered cohort without any prior card", async () => {
    const spawns = await yieldCohort("parent-turn", ["a", "b"]);
    answerWakes(newDraft(), [DONE]);
    await endRun("a");
    await endRun("b");
    expect(subagentRuns.get("b")?.requesterSettleWake).toBeUndefined();
    const stale = newDraft();
    expect(adoptSubagentProgressDraft(spawns, stale)).toBe(false);
    expect(stale.push).not.toHaveBeenCalled();
  });

  it.each([
    ["killSessionSubagentRuns", "running", "committed"],
    ["abortControlledSubagents", "completed", "committed"],
    ["killSessionSubagentRuns", "running", "rejected"],
    ["abortControlledSubagents", "completed", "rejected"],
  ] as const)(
    "retires the card only when %s commits stop of a completed and a %s child (%s)",
    async (stop, sibling, write) => {
      const draft = await adoptCohort();
      // Completed children still owe their pending requester wake when Stop arrives.
      fixture.wake.mockResolvedValue(false);
      await endRun("a");
      if (sibling === "completed") {
        await endRun("b");
      }
      expect(subagentRuns.get("a")?.requesterSettleWake?.status).toBe("pending");
      if (write === "rejected") {
        fixture.rejectRegistryWrites(
          (row) => Boolean(row.killIntent) || row.suppressCompletionDelivery === true,
          "stop write rejected",
        );
      }

      const result = await stops[stop](stopParams());
      await fixture.settle();

      expect(result?.status).toBe(write === "rejected" ? "error" : "ok");
      expectCard(draft, write === "rejected" ? 0 : 1);
    },
  );

  it("keeps the card until an uninterruptible child finishes", async () => {
    const draft = await adoptCohort(["a"]);
    const handle = createEmbeddedRunHandle({ runId: "a", isAbortable: false });
    attachRun("a-session", handle, childKey("a"), undefined, "main", undefined, undefined, {
      storeScope: storePath(),
    });
    try {
      await killSessionSubagentRuns(stopParams());
      await fixture.settle();

      const child = subagentRuns.get("a");
      expect(child).toMatchObject({ killIntent: undefined, execution: { status: "running" } });
      expect(child?.requesterSettleWake).toBeDefined();
      expect(draft.retire).not.toHaveBeenCalled();
    } finally {
      detachRun("a-session", handle, childKey("a"));
    }
    answerWakes(draft, [DONE]);
    await endRun("a");
    expect(draft.retire).toHaveBeenCalledOnce();
  });

  it("follows replacement execution until it settles", async () => {
    const draft = await adoptCohort();
    const wakes = answerWakes(draft, [DONE]);

    await endRun("a", { yielded: true, terminalReply: undefined });
    expect(
      await adoptPausedSubagentRunForFollowUp({
        childSessionKey: childKey("a"),
        runId: "a-resumed",
        task: "Continue delegated a",
      }),
    ).toBe(true);
    await fixture.settle();
    expect(subagentRuns.get("a-resumed")?.taskRunId).toBe("a");
    expect(draft.retire).not.toHaveBeenCalled();

    for (const [runId, name] of [
      ["a", "replaced_exec"],
      ["a-resumed", "exec"],
    ] as const) {
      emitAgentEvent({ runId, stream: "item", data: { kind: "tool", name, status: "running" } });
    }
    expect(draft.push).toHaveBeenCalledWith({
      itemId: "a:tool",
      kind: "tool",
      name: "exec",
      phase: "update",
      status: "running",
    });
    expect(JSON.stringify(draft.push.mock.calls)).not.toContain("replaced_exec");

    await endRun("a-resumed");
    await endRun("b");
    expect(wakes).toEqual([{ runId: expect.any(String), retiredBefore: 0 }]);
    expectCard(draft);
  });

  it("keeps the card through requester re-yield", async () => {
    const draft = await adoptCohort();
    const wakes = answerWakes(
      draft,
      ["Waiting for the follow-up checks.", "Everything is verified."],
      async (params) => {
        await yieldCohort(String(params?.idempotencyKey), ["c", "d"]);
      },
    );

    await endRun("a");
    await endRun("b");
    expect(wakes).toHaveLength(1);
    expect(draft.retire).not.toHaveBeenCalled();
    for (const itemId of ["c", "d"]) {
      expect(draft.push).toHaveBeenCalledWith(
        expect.objectContaining({ itemId, kind: "subagent", status: "running" }),
      );
    }

    await endRun("c");
    await endRun("d");
    expect(wakes).toHaveLength(2);
    expect(wakes[1]).toEqual({ runId: expect.any(String), retiredBefore: 0 });
    expect(wakes[1]!.runId).not.toBe(wakes[0]!.runId);
    expectCard(draft);
  });
});
