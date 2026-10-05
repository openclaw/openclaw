// Preserve fixture setup before production consumers.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../../test/helpers/sqlite-parent-observer.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { WRITE_SCOPE } from "../../../gateway/method-scopes.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import * as hookRuntime from "../../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { createDeferredCore as createDeferred } from "../../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { setTestEnvValue, withEnvAsync } from "../../../test-utils/env.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import * as registryReads from "./subagent-registry-read-cache.js";
import * as registryRead from "./subagent-registry-read.js";
import * as registryState from "./subagent-registry-state.js";
import {
  prepareSubagentSessionCleanupRevocation,
  registerSubagentRun,
  resumeSubagentRun,
} from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("../../../state/openclaw-state-worker-store.js", { spy: true });
vi.mock("./subagent-registry-read-cache.js", { spy: true });
vi.mock("./subagent-registry-read.js", { spy: true });
vi.mock("../../../plugins/hook-runner-global.js", { spy: true });
type AgentTurnService = ReturnType<
  (typeof import("../../../gateway/agent-turn/agent-turn-service.js"))["createAgentTurnService"]
>;
const turns = vi.hoisted(() => ({
  start: vi.fn<AgentTurnService["startTurn"]>(),
  wait: vi.fn<AgentTurnService["waitForTurn"]>(),
}));
vi.mock("../../../gateway/agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn: turns.start, waitForTurn: turns.wait }),
}));

const fixture = useSubagentControlFixture();
const nativeAnnounce = await vi.importActual<typeof import("../announce/subagent-announce.js")>(
  "../announce/subagent-announce.js",
);
const nativeWorker = await vi.importActual<typeof stateWorker>(
  "../../../state/openclaw-state-worker-store.js",
);
const nativeReads = await vi.importActual<typeof registryReads>(
  "./subagent-registry-read-cache.js",
);
const nativeRegistryRead = await vi.importActual<typeof registryRead>(
  "./subagent-registry-read.js",
);
const nativeWake = await vi.importActual<
  typeof import("../announce/subagent-announce.requester-settle-wake.js")
>("../announce/subagent-announce.requester-settle-wake.js");
beforeEach(() => {
  turns.start.mockReset().mockImplementation(async ({ io, assertAdmissionCurrent }) => {
    assertAdmissionCurrent?.();
    io.emitAcceptance([
      true,
      {
        runId: "synthetic-requester-turn",
        status: "ok",
        result: { payloads: [{ text: "Reviewed synthetic child." }] },
      },
      undefined,
    ]);
  });
  turns.wait.mockReset();
});

async function registerCompletion(
  runId: string,
  options: {
    cleanup?: "keep" | "delete";
    expectsCompletionMessage?: boolean;
    requesterSessionKey?: string;
  } = {},
) {
  const childSessionKey = `agent:main:subagent:${runId}`;
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childSessionKey,
    defaultSessionId: `${runId}-session`,
    lifecycleRevision: "original-child",
  });
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: "agent:main:main",
    defaultSessionId: "synthetic-requester-session",
    lifecycleRevision: "original-requester",
  });
  fixture.capture.mockResolvedValue("Synthetic completed result.");
  const context = createContext();
  context.localEmbedded = true;
  context.getRuntimeConfig = getRuntimeConfig;
  context.chatAbortControllers = new Map();
  context.chatQueuedTurns = new Map();
  const registry = createGatewayMethodRegistry([
    {
      name: "agent",
      owner: { kind: "core", area: "test" },
      scope: WRITE_SCOPE,
      handler: () => {
        throw new Error("Expected the typed agent turn facade");
      },
    },
  ]);
  context.getGatewayMethodRegistry = () => registry;
  await registerSubagentRun({
    runId,
    childSessionKey,
    requesterSessionKey: options.requesterSessionKey ?? "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "retain ordinary cleanup before requester settlement",
    cleanup: options.cleanup ?? "keep",
    expectsCompletionMessage: options.expectsCompletionMessage ?? true,
    gatewayContextResolver: () => context,
  });
  return { runId, childSessionKey };
}

function completeRegistered(
  run: { runId: string; childSessionKey: string },
  text: string | undefined = "Synthetic completed result.",
) {
  emitAgentEvent({
    runId: run.runId,
    sessionKey: run.childSessionKey,
    stream: "lifecycle",
    data: {
      phase: "end",
      endedAt: Date.now(),
      ...(text ? { terminalReply: { disposition: "visible", text } } : {}),
    },
  });
}

it.each(["announce receipt delete", "announce receipt keep"] as const)(
  "persists registered %s cleanup through the worker before handing off requester settlement",
  async (mode) => {
    const deleting = mode.endsWith("delete");
    const run = await registerCompletion(`ordinary-${mode.replaceAll(" ", "-")}`, {
      cleanup: deleting ? "delete" : "keep",
    });
    const { runId } = run;
    const announceDone =
      createDeferred<Awaited<ReturnType<typeof nativeAnnounce.runSubagentAnnounceFlow>>>();
    let deliveryAllowed: (() => boolean) | undefined;
    const publicationAdmission: boolean[] = [];
    const stopObserving = subscribeSubagentRunChanges("persistence", () => {
      const current = subagentRuns.get(runId);
      if (
        deliveryAllowed &&
        current?.delivery?.status === "delivered" &&
        current.cleanupCompletedAt === undefined
      ) {
        publicationAdmission.push(deliveryAllowed());
      }
    });
    fixture.announce.mockImplementation(async (params) => {
      deliveryAllowed = params.isCompletionDeliveryAllowed;
      try {
        const outcome = await nativeAnnounce.runSubagentAnnounceFlow(params);
        announceDone.resolve(outcome);
        return outcome;
      } catch (error) {
        announceDone.reject(error);
        throw error;
      }
    });

    let deleted = false;
    let deleteDispatchedAt: number | undefined;
    fixture.gateway.mockImplementation(async (request) => {
      if (request.method === "agent.wait") {
        return await new Promise<never>(() => {});
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Synthetic completed result." }],
            },
          ],
        };
      }
      if (request.method === "agent") {
        return {
          runId: "synthetic-requester-turn",
          status: "ok",
          result: { payloads: [{ text: "Reviewed synthetic child." }] },
        };
      }
      if (request.method !== "sessions.delete") {
        throw new Error(`Unexpected completion RPC ${request.method}`);
      }
      deleteDispatchedAt = loadSubagentRegistryFromSqlite().get(runId)?.deleteCleanupDispatchedAt;
      request.assertDispatchCurrent?.();
      deleted = true;
      return {};
    });
    let settledRecord: SubagentRunRecord | undefined;
    fixture.wake.mockImplementation(async () => {
      settledRecord = loadSubagentRegistryFromSqlite().get(runId);
      return false;
    });
    try {
      completeRegistered(run);
      const outcome = await announceDone.promise;
      expect(
        outcome,
        JSON.stringify({
          methods: fixture.gateway.mock.calls.map(([request]) => request.method),
          error: subagentRuns.get(runId)?.delivery?.lastError,
        }),
      ).toBe("delivered");
      await fixture.settle();
      expect(fixture.wake).toHaveBeenCalledOnce();
      expect(deleted).toBe(deleting);
      if (deleting) {
        expect(deleteDispatchedAt).toBeTypeOf("number");
      }
      expect(settledRecord).toMatchObject({
        cleanupHandled: true,
        cleanupCompletedAt: expect.any(Number),
        execution: { status: "terminal", outcome: { status: "ok" } },
      });
      expect(fixture.announce).toHaveBeenCalledOnce();
      expect(turns.start).toHaveBeenCalledOnce();
      expect(publicationAdmission.length).toBeGreaterThan(0);
      expect(publicationAdmission.every(Boolean), JSON.stringify(publicationAdmission)).toBe(true);
      expect(settledRecord?.delivery).toMatchObject({
        status: "delivered",
        deliveredAt: expect.any(Number),
      });
    } finally {
      stopObserving();
    }
  },
);

it("defers registered parent delivery until its descendant settles without host descendant reads", async () => {
  await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
    const parent = await registerCompletion("ordinary-deferred-parent");
    const child = await registerCompletion("ordinary-deferred-child", {
      requesterSessionKey: parent.childSessionKey,
      expectsCompletionMessage: false,
    });
    const originalParent = subagentRuns.get(parent.runId)!;
    const continuationRunId = "deferred-parent-continuation";
    turns.start.mockImplementation(async ({ io, assertAdmissionCurrent, preflight }) => {
      assertAdmissionCurrent?.();
      io.emitAcceptance([
        true,
        {
          runId:
            preflight.request.sessionKey === parent.childSessionKey
              ? continuationRunId
              : "deferred-parent-outward-delivery",
          status: "ok",
          result: { payloads: [{ text: "Reviewed synthetic child." }] },
        },
        undefined,
      ]);
    });
    const reads: { phase: "announce" | "cleanup"; counts: ReturnType<typeof emptySqliteCounts> }[] =
      [];
    let phase: "announce" | "cleanup" = "cleanup";
    fixture.wake.mockResolvedValue(false);
    fixture.announce.mockImplementation(async (params) => {
      phase = "announce";
      try {
        return await nativeAnnounce.runSubagentAnnounceFlow(params);
      } finally {
        phase = "cleanup";
      }
    });
    function observeRead<T>(read: () => T): T {
      const selectedPhase = phase;
      // Only the actual descendant read is measured here; transport and fixture
      // writes remain outside this window. Preserve sync/async return semantics for RED.
      const sql = observeParentSqlite();
      const record = () => {
        reads.push({ phase: selectedPhase, counts: { ...sql.counts } });
        sql.restore();
      };
      try {
        const result = read();
        if (result instanceof Promise) {
          void result.then(record, record);
        } else {
          record();
        }
        return result;
      } catch (error) {
        record();
        throw error;
      }
    }
    const count = vi
      .spyOn(registryRead, "countPendingDescendantRuns")
      .mockImplementation((...args) =>
        observeRead(() => nativeRegistryRead.countPendingDescendantRuns(...args)),
      );
    try {
      registryState.clearSubagentRunsReadCacheForTest();
      completeRegistered(parent);
      await fixture.settle();
      const deferred = loadSubagentRegistryFromSqlite().get(parent.runId);
      expect(deferred).toMatchObject({
        cleanupHandled: false,
        wakeOnDescendantSettle: true,
        execution: { status: "terminal", outcome: { status: "ok" } },
      });
      expect(deferred?.cleanupCompletedAt).toBeUndefined();
      expect(turns.start).not.toHaveBeenCalled();
      expect(fixture.wake).not.toHaveBeenCalled();
      expect(reads.map((read) => read.phase)).toEqual(
        expect.arrayContaining(["announce", "cleanup"]),
      );

      for (const read of reads) {
        expect(read.counts, read.phase).toEqual(emptySqliteCounts());
      }

      completeRegistered(child);
      await fixture.settle();
      expect(turns.start).toHaveBeenCalledOnce();
      expect(turns.start.mock.calls[0]?.[0].preflight.request.sessionKey).toBe(
        parent.childSessionKey,
      );
      const afterWake = loadSubagentRegistryFromSqlite();
      expect(afterWake.has(parent.runId)).toBe(false);
      expect(subagentRuns.has(parent.runId)).toBe(false);
      expect(afterWake.get(continuationRunId)).toMatchObject({
        taskRunId: parent.runId,
        childSessionKey: parent.childSessionKey,
        requesterSessionKey: "agent:main:main",
        execution: { status: "running" },
      });
      expect(afterWake.get(continuationRunId)!.generation).toBeGreaterThan(
        originalParent.generation!,
      );
      completeRegistered({ runId: continuationRunId, childSessionKey: parent.childSessionKey });
      await fixture.settle();
      expect(
        turns.start.mock.calls.map(([request]) => request.preflight.request.sessionKey),
      ).toEqual([parent.childSessionKey, "agent:main:main"]);
      expect(loadSubagentRegistryFromSqlite().get(continuationRunId)).toMatchObject({
        cleanupCompletedAt: expect.any(Number),
        delivery: { status: "delivered", deliveredAt: expect.any(Number) },
      });
      expect(loadSubagentRegistryFromSqlite().get(child.runId)?.cleanupCompletedAt).toBeTypeOf(
        "number",
      );
    } finally {
      count.mockRestore();
      await fixture.settle();
    }
  });
});

it("keeps a delivered announcement fenced when its committed native receipt is unreadable", async () => {
  const run = await registerCompletion("uncertain-announcement-receipt", {
    cleanup: "delete",
  });
  const completed = createDeferred<
    { kind: "failed"; error: unknown } | { kind: "returned"; value: string }
  >();
  let deliveryAllowed: (() => boolean) | undefined;
  fixture.announce.mockImplementation(async (params) => {
    deliveryAllowed = params.isCompletionDeliveryAllowed;
    try {
      const value = await nativeAnnounce.runSubagentAnnounceFlow(params);
      completed.resolve({ kind: "returned", value });
      return value;
    } catch (error) {
      completed.resolve({ kind: "failed", error });
      throw error;
    }
  });
  let lost = false;
  const worker = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((stateContext, operation, options) => {
      let admission: SqliteWorkerOperationAdmission | undefined;
      const createAdmission = options?.createAdmission;
      return nativeWorker.runOpenClawStateWorkerOperation(
        stateContext,
        (scope) =>
          operation({
            async execute(command, executeOptions) {
              const receiptWrite =
                !lost &&
                isSubagentRegistryWriteCommand(command) &&
                command.input.values.some(
                  (row) =>
                    row.run_id === run.runId &&
                    rowToSubagentRunRecord(row)?.delivery?.status === "delivered",
                );
              const result = await scope.execute(command, executeOptions);
              if (receiptWrite) {
                lost = true;
                admission?.service();
                if (!admission?.committed) {
                  throw new Error("Delivery receipt has no native commit facts");
                }
                Object.defineProperty(admission, "committed", { value: { facts: undefined } });
                throw new SqliteWorkerError(
                  "Synthetic unreadable delivery receipt acknowledgement",
                  "outcome-unknown",
                );
              }
              return result;
            },
          }),
        {
          ...options,
          createAdmission: createAdmission
            ? (operationAdmission) => {
                const created = createAdmission(operationAdmission);
                admission = created.admission;
                return created;
              }
            : undefined,
        },
      );
    });
  try {
    completeRegistered(run);
    const result = await completed.promise;
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") {
      throw new Error(`Expected uncertain persistence, received ${result.value}`);
    }
    expect(result.error).toMatchObject({ outcome: "committed" });
    if (!(result.error instanceof Error)) {
      throw new Error("Expected the retained registry write failure");
    }
    await expect(fixture.settle()).rejects.toMatchObject({
      name: "AggregateError",
      message: "Failed to settle subagent cleanup roots",
      errors: [result.error],
    });
    expect(lost).toBe(true);
    expect(loadSubagentRegistryFromSqlite().get(run.runId)?.delivery?.status).toBe("delivered");
    expect(subagentRuns.get(run.runId)?.delivery?.status).toBe("pending");
    expect(subagentRuns.get(run.runId)?.cleanupHandled).toBe(true);
    expect(deliveryAllowed).toBeTypeOf("function");
    expect(() => deliveryAllowed?.()).toThrow(result.error);
    resumeSubagentRun(run.runId);
    await fixture.settle();
    expect(turns.start).toHaveBeenCalledOnce();
    expect(fixture.announce).toHaveBeenCalledOnce();
    expect(fixture.wake).not.toHaveBeenCalled();
    expect(
      fixture.gateway.mock.calls.some(([request]) => request.method === "sessions.delete"),
    ).toBe(false);
  } finally {
    worker.mockRestore();
    await fixture.settle();
    await closeOpenClawStateDatabaseAsync();
    await restoreSubagentRunsFromDisk({ runs: subagentRuns });
  }
});

it("refuses an old registered wake after its descendant read outlives a successor", async () => {
  await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
    const run = await registerCompletion("held-descendant-read", {
      expectsCompletionMessage: false,
    });
    const original = subagentRuns.get(run.runId)!;
    const ready = createDeferred();
    const release = createDeferred();
    const mutations: { entry: SubagentRunRecord; kind: "transition" | "complete" }[] = [];
    fixture.wake.mockImplementation(async (params) => {
      registryState.clearSubagentRunsReadCacheForTest();
      return nativeWake.maybeWakeRequesterAfterAllChildrenSettled({
        ...params,
        transitionBatch: async (...args) => {
          mutations.push({ entry: params.settledEntry, kind: "transition" });
          return params.transitionBatch(...args);
        },
        completeBatch: async (...args) => {
          mutations.push({ entry: params.settledEntry, kind: "complete" });
          return params.completeBatch(...args);
        },
      });
    });
    let held = false;
    const reader = vi
      .spyOn(registryReads, "readCompactSubagentRuns")
      .mockImplementation(async (context) => {
        const result = await nativeReads.readCompactSubagentRuns(context);
        if (!held && subagentRuns.get(run.runId)?.cleanupCompletedAt !== undefined) {
          held = true;
          // The actual read has released its broker slot before successor registration.
          ready.resolve();
          await release.promise;
        }
        return result;
      });
    try {
      completeRegistered(run);
      await ready.promise;
      expect(loadSubagentRegistryFromSqlite().get(run.runId)?.requesterSettleWake).toBeDefined();
      await registerSubagentRun({
        ...run,
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: "legitimate successor after the held wake",
        cleanup: "keep",
        expectsCompletionMessage: false,
      });
      const successor = subagentRuns.get(run.runId)!;
      expect(successor).not.toBe(original);
      const durableSuccessor = loadSubagentRegistryFromSqlite().get(run.runId);
      expect(durableSuccessor?.execution.status).toBe("running");
      release.resolve();
      await fixture.settle();
      expect(mutations).toEqual([]);
      expect(subagentRuns.get(run.runId)).toBe(successor);
      expect(loadSubagentRegistryFromSqlite().get(run.runId)).toEqual(durableSuccessor);

      completeRegistered(run);
      await fixture.settle();
      expect(
        mutations.map(({ entry, kind }) => ({
          runId: entry.runId,
          generation: entry.generation,
          kind,
        })),
      ).toEqual([{ runId: successor.runId, generation: successor.generation, kind: "complete" }]);
      const completed = loadSubagentRegistryFromSqlite().get(run.runId);
      expect(completed).toMatchObject({
        task: "legitimate successor after the held wake",
        execution: { status: "terminal", outcome: { status: "ok" } },
        cleanupCompletedAt: expect.any(Number),
      });
      expect(completed?.requesterSettleWake).toBeUndefined();
      expect(fixture.announce).not.toHaveBeenCalled();
      expect(turns.start).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await fixture.settle();
      reader.mockRestore();
    }
  });
});

it.for(["current", "successor", "revoked", "source switched"] as const)(
  "retains ended-hook authority through a registered requester-wake acknowledgement (%s)",
  async (change, { signal }) => {
    const run = await registerCompletion("hook-wake-ack");
    const original = subagentRuns.get(run.runId)!;
    const source = captureOpenClawStateWorkerContext();
    const originalDatabase = openOpenClawStateDatabase({ path: source.admission.databasePath });
    const replacementDir = path.join(fixture.stateDir, "replacement-state");
    if (change === "source switched") {
      openOpenClawStateDatabase({
        path: path.join(replacementDir, path.basename(source.admission.databasePath)),
      });
    }
    fixture.announce.mockImplementation(nativeAnnounce.runSubagentAnnounceFlow);
    const pluginEntered = createDeferred();
    const mutationReady = createDeferred();
    const releaseHook = createDeferred();
    const release = createDeferred();
    fixture.wake.mockImplementation(async (params) => {
      await pluginEntered.promise;
      return nativeWake.maybeWakeRequesterAfterAllChildrenSettled(params);
    });
    const ended = vi.fn(async () => {
      pluginEntered.resolve();
      await releaseHook.promise;
    });
    const releaseCancelledTest = () => {
      pluginEntered.resolve();
      mutationReady.resolve();
      release.resolve();
      releaseHook.resolve();
    };
    signal.addEventListener("abort", releaseCancelledTest, { once: true });
    const { registry, runner } = createHookRunnerWithRegistry([
      { hookName: "subagent_ended", handler: ended },
    ]);
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(registry);
    vi.spyOn(hookRuntime, "getGlobalHookRunner").mockReturnValue(runner);
    let held = false;
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        nativeWorker.runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            operation({
              async execute(command, executeOptions) {
                const result = await scope.execute(command, executeOptions);
                if (
                  !held &&
                  command.type === "sessionDelivery.mutateSubagentCompletion" &&
                  subagentRuns.get(run.runId)?.cleanupCompletedAt !== undefined
                ) {
                  held = true;
                  // The actual wake has committed; row admission retains its ACK until publication.
                  mutationReady.resolve();
                  await release.promise;
                }
                return result;
              },
            }),
          options,
        ),
      );
    try {
      completeRegistered(run);
      await mutationReady.promise;
      expect(ended).toHaveBeenCalledOnce();
      expect(subagentRuns.get(run.runId)?.endedHookEmittedAt).toBeUndefined();
      const committed = loadSubagentRegistryFromSqlite(originalDatabase).get(run.runId);
      expect(committed?.cleanupCompletedAt).toBeTypeOf("number");
      expect(committed?.requesterSettleWake).toBeUndefined();
      let successor: SubagentRunRecord | undefined;
      let authorityChange: Promise<unknown> | undefined;
      if (change === "successor") {
        authorityChange = registerSubagentRun({
          ...run,
          requesterSessionKey: "agent:main:main",
          requesterAgentId: "main",
          requesterDisplayKey: "main",
          task: "successor after observed hook",
          cleanup: "keep",
          expectsCompletionMessage: false,
        });
      } else if (change === "revoked") {
        authorityChange = prepareSubagentSessionCleanupRevocation(run.childSessionKey).then(
          (guard) => guard(),
        );
      } else if (change === "source switched") {
        setTestEnvValue("OPENCLAW_STATE_DIR", replacementDir);
      }
      release.resolve();
      await authorityChange;
      if (change === "successor") {
        successor = subagentRuns.get(run.runId)!;
        expect(successor.generation).toBeGreaterThan(original.generation!);
      } else if (change === "revoked") {
        expect(subagentRuns.get(run.runId)?.execution.suppressSessionEffects).toBe(true);
      }
      releaseHook.resolve();
      await fixture.settle();
      const stored = loadSubagentRegistryFromSqlite(originalDatabase).get(run.runId);
      expect(ended).toHaveBeenCalledOnce();
      expect(fixture.announce).toHaveBeenCalledOnce();
      expect(turns.start).toHaveBeenCalledOnce();
      if (change === "current") {
        expect(stored?.endedHookEmittedAt).toBeTypeOf("number");
        expect(stored?.requesterSettleWake).toBeUndefined();
        resumeSubagentRun(run.runId);
        await fixture.settle();
        expect(ended).toHaveBeenCalledOnce();
      } else {
        expect(subagentRuns.get(run.runId)?.endedHookEmittedAt).toBeUndefined();
        expect(stored?.endedHookEmittedAt).toBeUndefined();
        if (successor) {
          expect(subagentRuns.get(run.runId)).toBe(successor);
          expect(stored).toMatchObject({
            task: "successor after observed hook",
            generation: successor.generation,
            execution: { status: "running" },
          });
        }
      }
    } finally {
      release.resolve();
      releaseHook.resolve();
      await fixture.settle();
      setTestEnvValue("OPENCLAW_STATE_DIR", fixture.stateDir);
      worker.mockRestore();
      signal.removeEventListener("abort", releaseCancelledTest);
    }
  },
);
