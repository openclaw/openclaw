// Preserve fixture setup before production consumers.
// oxfmt-ignore
import { runSubagentStateWorkerOperation as runWorker, useSubagentControlFixture } from "./subagent-control.test-support.js";
import path from "node:path";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore as createDeferred } from "../../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { setTestEnvValue, withEnvAsync } from "../../../test-utils/env.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import {
  announcementFixture,
  completeRegistered,
  currentRun,
  holdAnnouncementCommand,
  installEndedHook,
  registerSuccessor,
  storedAnnouncement,
  withUnreadableReceipt,
} from "./subagent-announcement.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import * as registryReads from "./subagent-registry-read-cache.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import * as registryState from "./subagent-registry-state.js";
import { prepareSubagentSessionCleanupRevocation, resumeSubagentRun } from "./subagent-registry.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("../../../state/openclaw-state-worker-store.js", { spy: true });
vi.mock("./subagent-registry-read-cache.js", { spy: true });
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
const nativeReads = await vi.importActual<typeof registryReads>(
  "./subagent-registry-read-cache.js",
);
const nativeWake = await vi.importActual<
  typeof import("../announce/subagent-announce.requester-settle-wake.js")
>("../announce/subagent-announce.requester-settle-wake.js");

function acceptTurn(io: Parameters<AgentTurnService["startTurn"]>[0]["io"], runId: string) {
  io.emitAcceptance([
    true,
    { runId, status: "ok", result: { payloads: [{ text: "Reviewed synthetic child." }] } },
    undefined,
  ]);
}

beforeEach(() => {
  turns.start.mockReset().mockImplementation(async ({ io, assertAdmissionCurrent }) => {
    assertAdmissionCurrent?.();
    acceptTurn(io, "synthetic-requester-turn");
  });
  turns.wait.mockReset();
});

const registerCompletion = announcementFixture(fixture, true);

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
      const current = currentRun(runId);
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
      if (request.method !== "sessions.delete") {
        throw new Error(`Unexpected completion RPC ${request.method}`);
      }
      deleteDispatchedAt = storedAnnouncement(runId)?.deleteCleanupDispatchedAt;
      request.assertDispatchCurrent?.();
      deleted = true;
      return {};
    });
    let settledRecord: SubagentRunRecord | undefined;
    fixture.wake.mockImplementation(async () => {
      settledRecord = storedAnnouncement(runId);
      return false;
    });
    try {
      completeRegistered(run);
      const outcome = await announceDone.promise;
      expect(outcome).toBe("delivered");
      await fixture.settle();
      expect(deleted).toBe(deleting);
      if (deleting) {
        expect(deleteDispatchedAt).toBeTypeOf("number");
      }
      expect(settledRecord).toMatchObject({
        cleanupHandled: true,
        cleanupCompletedAt: expect.any(Number),
        execution: { status: "terminal", outcome: { status: "ok" } },
        delivery: { status: "delivered", deliveredAt: expect.any(Number) },
      });
      expect(turns.start).toHaveBeenCalledOnce();
      expect(publicationAdmission.length).toBeGreaterThan(0);
      expect(publicationAdmission.every(Boolean), JSON.stringify(publicationAdmission)).toBe(true);
    } finally {
      stopObserving();
    }
  },
);

it("defers registered parent delivery until its descendant settles", async () => {
  await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
    const parent = await registerCompletion("ordinary-deferred-parent");
    const child = await registerCompletion("ordinary-deferred-child", {
      requesterSessionKey: parent.childSessionKey,
      expectsCompletionMessage: false,
    });
    const originalParent = currentRun(parent.runId)!;
    const continuationRunId = "deferred-parent-continuation";
    turns.start.mockImplementation(async ({ io, assertAdmissionCurrent, preflight }) => {
      assertAdmissionCurrent?.();
      acceptTurn(
        io,
        preflight.request.sessionKey === parent.childSessionKey
          ? continuationRunId
          : "deferred-parent-outward-delivery",
      );
    });
    fixture.wake.mockResolvedValue(false);
    fixture.announce.mockImplementation(nativeAnnounce.runSubagentAnnounceFlow);
    try {
      registryState.clearSubagentRunsReadCacheForTest();
      completeRegistered(parent);
      await fixture.settle();
      const deferred = storedAnnouncement(parent.runId);
      expect(deferred).toMatchObject({
        cleanupHandled: false,
        wakeOnDescendantSettle: true,
        execution: { status: "terminal", outcome: { status: "ok" } },
      });
      expect(deferred?.cleanupCompletedAt).toBeUndefined();
      expect(turns.start).not.toHaveBeenCalled();
      expect(fixture.wake).not.toHaveBeenCalled();
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
      expect(storedAnnouncement(continuationRunId)).toMatchObject({
        cleanupCompletedAt: expect.any(Number),
        delivery: { status: "delivered", deliveredAt: expect.any(Number) },
      });
      expect(storedAnnouncement(child.runId)?.cleanupCompletedAt).toBeTypeOf("number");
    } finally {
      await fixture.settle();
    }
  });
});

it("keeps a delivered announcement fenced when its committed native receipt is unreadable", async () => {
  const run = await registerCompletion("uncertain-announcement-receipt", {
    cleanup: "delete",
  });
  const completed = createDeferred<unknown>();
  let deliveryAllowed: (() => boolean) | undefined;
  fixture.announce.mockImplementation(async (params) => {
    deliveryAllowed = params.isCompletionDeliveryAllowed;
    try {
      const value = await nativeAnnounce.runSubagentAnnounceFlow(params);
      completed.resolve(value);
      return value;
    } catch (error) {
      completed.resolve(error);
      throw error;
    }
  });
  let lost = false;
  const worker = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      withUnreadableReceipt(
        runWorker,
        context,
        operation,
        options,
        (command) =>
          !lost &&
          isSubagentRegistryWriteCommand(command) &&
          command.input.values.some(
            (row) =>
              row.run_id === run.runId &&
              rowToSubagentRunRecord(row)?.delivery?.status === "delivered",
          ),
        () => {
          lost = true;
        },
      ),
    );
  try {
    completeRegistered(run);
    const error = await completed.promise;
    assert(error instanceof Error, "Expected the retained registry write failure");
    expect(error).toMatchObject({ outcome: "committed" });
    await expect(fixture.settle()).rejects.toMatchObject({
      name: "AggregateError",
      message: "Failed to settle subagent cleanup roots",
      errors: [error],
    });
    expect(lost).toBe(true);
    expect(storedAnnouncement(run.runId)?.delivery?.status).toBe("delivered");
    expect(currentRun(run.runId)?.delivery?.status).toBe("pending");
    expect(currentRun(run.runId)?.cleanupHandled).toBe(true);
    expect(deliveryAllowed).toBeTypeOf("function");
    expect(() => deliveryAllowed?.()).toThrow(error);
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
    const original = currentRun(run.runId)!;
    const ready = createDeferred();
    const release = createDeferred();
    const completedRuns: SubagentRunRecord[] = [];
    fixture.wake.mockImplementation(async (params) => {
      registryState.clearSubagentRunsReadCacheForTest();
      return nativeWake.maybeWakeRequesterAfterAllChildrenSettled({
        ...params,
        completeBatch: async (...args) => {
          completedRuns.push(params.settledEntry);
          return params.completeBatch(...args);
        },
      });
    });
    let held = false;
    const reader = vi
      .spyOn(registryReads, "readCompactSubagentRuns")
      .mockImplementation(async (context) => {
        const result = await nativeReads.readCompactSubagentRuns(context);
        if (!held && currentRun(run.runId)?.cleanupCompletedAt !== undefined) {
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
      expect(storedAnnouncement(run.runId)?.requesterSettleWake).toBeDefined();
      await registerSuccessor(original, "legitimate successor after the held wake");
      const successor = currentRun(run.runId)!;
      expect(successor).not.toBe(original);
      const durableSuccessor = storedAnnouncement(run.runId);
      expect(durableSuccessor?.execution.status).toBe("running");
      release.resolve();
      await fixture.settle();
      expect(completedRuns).toEqual([]);
      expect(currentRun(run.runId)).toBe(successor);
      expect(storedAnnouncement(run.runId)).toEqual(durableSuccessor);

      completeRegistered(run);
      await fixture.settle();
      expect(completedRuns.map(({ runId, generation }) => ({ runId, generation }))).toEqual([
        { runId: successor.runId, generation: successor.generation },
      ]);
      const completed = storedAnnouncement(run.runId);
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
    const original = currentRun(run.runId)!;
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
    const releaseHook = createDeferred();
    fixture.wake.mockImplementation(async (params) => {
      await pluginEntered.promise;
      return nativeWake.maybeWakeRequesterAfterAllChildrenSettled(params);
    });
    const ended = vi.fn(async () => {
      pluginEntered.resolve();
      await releaseHook.promise;
    });
    const {
      ready: mutationReady,
      release,
      worker,
    } = holdAnnouncementCommand(
      (command) =>
        command.type === "sessionDelivery.mutateSubagentCompletion" &&
        currentRun(run.runId)?.cleanupCompletedAt !== undefined,
      true,
    );
    const releaseCancelledTest = () => {
      pluginEntered.resolve();
      mutationReady.resolve();
      release.resolve();
      releaseHook.resolve();
    };
    signal.addEventListener("abort", releaseCancelledTest, { once: true });
    installEndedHook(ended);
    try {
      completeRegistered(run);
      await mutationReady.promise;
      expect(ended).toHaveBeenCalledOnce();
      expect(currentRun(run.runId)?.endedHookEmittedAt).toBeUndefined();
      const committed = storedAnnouncement(run.runId, originalDatabase);
      expect(committed?.cleanupCompletedAt).toBeTypeOf("number");
      expect(committed?.requesterSettleWake).toBeUndefined();
      let successor: SubagentRunRecord | undefined;
      let authorityChange: Promise<unknown> | undefined;
      if (change === "successor") {
        authorityChange = registerSuccessor(original, "successor after observed hook");
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
        successor = currentRun(run.runId)!;
        expect(successor.generation).toBeGreaterThan(original.generation!);
      } else if (change === "revoked") {
        expect(currentRun(run.runId)?.execution.suppressSessionEffects).toBe(true);
      }
      releaseHook.resolve();
      await fixture.settle();
      const stored = storedAnnouncement(run.runId, originalDatabase);
      expect(ended).toHaveBeenCalledOnce();
      expect(turns.start).toHaveBeenCalledOnce();
      if (change === "current") {
        expect(stored?.endedHookEmittedAt).toBeTypeOf("number");
        expect(stored?.requesterSettleWake).toBeUndefined();
        resumeSubagentRun(run.runId);
        await fixture.settle();
        expect(ended).toHaveBeenCalledOnce();
      } else {
        expect(currentRun(run.runId)?.endedHookEmittedAt).toBeUndefined();
        expect(stored?.endedHookEmittedAt).toBeUndefined();
        if (successor) {
          expect(currentRun(run.runId)).toBe(successor);
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
