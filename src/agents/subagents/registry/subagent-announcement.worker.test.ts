// Preserve fixture setup before production consumers.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { setTestEnvValue } from "../../../test-utils/env.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import {
  announcementFixture,
  completeRegistered,
  currentRun,
  holdAnnouncementCommand,
  installEndedHook,
  registerSuccessor,
  storedAnnouncement,
  suspendRun,
  updateRun,
} from "./subagent-announcement.test-support.js";
import * as registryDeps from "./subagent-registry-deps.js";
import * as registryHelpers from "./subagent-registry-helpers.js";
import * as announceCleanup from "./subagent-registry-lifecycle-announce-cleanup.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import {
  getSubagentRegistryPublicationRevision,
  subscribeSubagentRunChanges,
} from "./subagent-registry-publication.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { resumeSubagentRun, prepareSubagentSessionCleanupRevocation } from "./subagent-registry.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { testing } from "./subagent-registry.test-helpers.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

vi.mock("../../../state/openclaw-state-worker-store.js", { spy: true });

vi.mock("./subagent-registry-lifecycle-announce-cleanup.js", { spy: true });

vi.mock("./subagent-registry-persistence.js", { spy: true });

vi.mock("../../../plugins/hook-runner-global.js", { spy: true });

const fixture = useSubagentControlFixture();

const nativeCleanup = await vi.importActual<typeof announceCleanup>(
  "./subagent-registry-lifecycle-announce-cleanup.js",
);

const nativePersistence = await vi.importActual<
  typeof import("./subagent-registry-persistence.js")
>("./subagent-registry-persistence.js");

const registerCompletion = announcementFixture(fixture, false);

it.each(["keep", "delete"] as const)("settles registered quiet %s completion", async (cleanup) => {
  const run = await registerCompletion(`ordinary-announcement-${cleanup}`, { cleanup });
  const { runId } = run;
  const deleted: unknown[] = [];
  fixture.gateway.mockImplementation(async (request) => {
    if (request.method === "agent.wait") {
      return await new Promise<never>(() => {});
    }
    if (request.method !== "sessions.delete") {
      throw new Error(`Unexpected RPC ${request.method}`);
    }
    request.assertDispatchCurrent?.();
    deleted.push({
      request: request.params,
      marker: storedAnnouncement(runId)?.deleteCleanupDispatchedAt,
    });
    return {};
  });
  completeRegistered(run);
  await fixture.settle();
  expect(storedAnnouncement(runId)).toMatchObject({
    cleanupCompletedAt: expect.any(Number),
    execution: { status: "terminal", outcome: { status: "ok" } },
    delivery: { status: "not_required" },
  });
  expect(fixture.announce).not.toHaveBeenCalled();
  expect(deleted).toHaveLength(cleanup === "delete" ? 1 : 0);
  if (cleanup === "delete") {
    expect(deleted[0]).toMatchObject({
      marker: expect.any(Number),
      request: {
        key: run.childSessionKey,
        expectedSessionId: "ordinary-child-session",
        expectedLifecycleRevision: "ordinary-child-revision",
      },
    });
  }
});

it("retains registered cleanup admission behind a durable write while a successor queues", async () => {
  const run = await registerCompletion("cleanup-start-successor");
  const entry = currentRun(run.runId)!;
  const successorQueued = createDeferredCore();
  const mutation = vi.mocked(mutateSubagentRuns).mockImplementation((runIds, plan, options) => {
    const pending = nativePersistence.mutateSubagentRuns(runIds, plan, options);
    if (runIds.includes(`${run.runId}-successor`)) {
      successorQueued.resolve();
    }
    return pending;
  });
  let predecessor: Promise<void> | undefined;
  const start = vi
    .spyOn(announceCleanup, "startSubagentAnnounceCleanupFlow")
    .mockImplementation((context, ...args) => {
      predecessor ??= updateRun(run.runId, (draft) => {
        draft.label = "queued before cleanup";
      });
      return nativeCleanup.startSubagentAnnounceCleanupFlow(context, ...args);
    });
  const { ready, release, worker } = holdAnnouncementCommand(
    (command) =>
      isSubagentRegistryWriteCommand(command) &&
      command.input.values.some(
        (row) =>
          row.run_id === run.runId &&
          rowToSubagentRunRecord(row)?.label === "queued before cleanup",
      ),
  );
  let registration: Promise<void> | undefined;
  try {
    completeRegistered(run);
    await ready.promise;
    expect(currentRun(run.runId)?.cleanupHandled).not.toBe(true);
    expect(storedAnnouncement(run.runId)?.cleanupHandled).not.toBe(true);
    expect(fixture.wake).not.toHaveBeenCalled();
    resumeSubagentRun(run.runId);
    registration = registerSuccessor(entry, "new child generation", {
      runId: `${run.runId}-successor`,
    });
    await successorQueued.promise;
    release.resolve();
    await predecessor;
    await registration;
    await fixture.settle();
    expect(fixture.wake).toHaveBeenCalledOnce();
    expect(storedAnnouncement(run.runId)).toMatchObject({
      cleanupCompletedAt: expect.any(Number),
      execution: { status: "terminal", suppressSessionEffects: true },
    });
    expect(currentRun(`${run.runId}-successor`)?.execution.status).toBe("running");
  } finally {
    release.resolve();
    mutation.mockRestore();
    worker.mockRestore();
    start.mockRestore();
    await predecessor;
    await registration;
    await fixture.settle();
  }
});

it("refuses cleanup before capture when its database is closed", async () => {
  const joinWork = observeRootWork();
  const run = await registerCompletion("sealed-cleanup-start", { holdForRequester: true });
  completeRegistered(run);
  await joinWork(true);
  await fixture.settle();
  await updateRun(run.runId, (draft) => {
    draft.suppressCompletionDelivery = true;
  });
  const entry = currentRun(run.runId)!;
  const before = storedAnnouncement(run.runId);
  let closing: Promise<void> | undefined;
  const start = vi
    .spyOn(announceCleanup, "startSubagentAnnounceCleanupFlow")
    .mockImplementation((...args) => {
      closing ??= closeOpenClawStateDatabaseAsync();
      return nativeCleanup.startSubagentAnnounceCleanupFlow(...args);
    });
  try {
    expect(() => resumeSubagentRun(run.runId)).toThrow("state database read admission is closed");
    await closing;
    expect(entry.cleanupHandled).not.toBe(true);
    expect(storedAnnouncement(run.runId)).toEqual(before);
    expect(fixture.wake).not.toHaveBeenCalled();
    start.mockRestore();
    resumeSubagentRun(run.runId);
    await joinWork(true);
    await fixture.settle();
    expect(storedAnnouncement(run.runId)?.cleanupCompletedAt).toBeTypeOf("number");
    expect(fixture.announce).not.toHaveBeenCalled();
  } finally {
    start.mockRestore();
    await joinWork();
    await closing;
  }
});

it.each(["current", "revoked", "source switched", "yielded"] as const)(
  "uses current authority for an ended hook after suspended bookkeeping (%s)",
  async (change) => {
    const runId = "suspended-announcement-hook";
    const waitResult = createDeferredCore<Record<string, unknown>>();
    const waitStarted = createDeferredCore();
    if (change === "yielded") {
      fixture.gateway.mockImplementation(async (request) => {
        if (request.method !== "agent.wait") {
          throw new Error(`Unexpected RPC ${request.method}`);
        }

        waitStarted.resolve();
        return await waitResult.promise;
      });
    }
    const { childSessionKey } = await registerCompletion(runId, { holdForRequester: true });
    await updateRun(runId, (draft) => {
      draft.retainAttachmentsOnKeep = true;
    });
    const registeredEntry = currentRun(runId);

    if (change === "yielded") {
      await waitStarted.promise;
    }

    const settleCompletion = observeRootWork();
    try {
      completeRegistered({ runId, childSessionKey }, "Suspended synthetic result.");
    } finally {
      await settleCompletion();
    }

    await fixture.settle();

    const originalSource = captureOpenClawStateWorkerContext();
    const replacementDir = path.join(fixture.stateDir, "replacement-state");
    if (change === "source switched") {
      openOpenClawStateDatabase({
        path: path.join(replacementDir, path.basename(originalSource.admission.databasePath)),
      });
    }
    let pausedRecord: ReturnType<typeof currentRun>;
    await suspendRun(runId);
    const ended = vi.fn(async () => {});
    const registry = installEndedHook(ended);
    const ready = createDeferredCore();
    const release = createDeferredCore();
    const preparingHook = vi
      .spyOn(registryDeps, "loadSubagentRegistryPluginRuntimeHandle")
      .mockImplementation(async () => {
        ready.resolve();
        await release.promise;
        return registry;
      });
    const sweeping = testing.sweepOnceForTests();
    const sweepOutcome = sweeping.then(
      () => ({ completed: true as const }),
      (error: unknown) => ({ completed: false as const, error }),
    );
    try {
      await ready.promise;

      expect(storedAnnouncement(runId)?.cleanupCompletedAt).toBeTypeOf("number");
      expect(ended).not.toHaveBeenCalled();
      if (change === "revoked") {
        (await prepareSubagentSessionCleanupRevocation(childSessionKey))();
        expect(storedAnnouncement(runId)?.execution.suppressSessionEffects).toBe(true);
      }
      if (change === "source switched") {
        setTestEnvValue("OPENCLAW_STATE_DIR", replacementDir);
        expect(() => originalSource.admission.assertCurrent()).not.toThrow();
      }
      if (change === "yielded") {
        const paused = createDeferredCore();
        const stop = subscribeSubagentRunChanges("persistence", () => {
          if (currentRun(runId)?.pauseReason === "sessions_yield") {
            paused.resolve();
          }
        });
        try {
          waitResult.resolve({ status: "ok", yielded: true, endedAt: Date.now() });
          await paused.promise;
        } finally {
          stop();
        }
        expect(currentRun(runId)?.generation).toBe(registeredEntry?.generation);
        pausedRecord = structuredClone(currentRun(runId)!);
        expect(storedAnnouncement(runId)?.pauseReason).toBe("sessions_yield");
      }
      release.resolve();
      const outcome = await sweepOutcome;
      await fixture.settle().catch(async (error: unknown) => {
        if (change !== "source switched" || !(error instanceof AggregateError)) {
          throw error;
        }
        // Queued cleanup can observe the same source change as the suspended hook.
        expect(error.errors.length).toBeGreaterThan(0);
        for (const failure of error.errors) {
          expect(failure).toBeInstanceOf(Error);
          expect(failure).toMatchObject({
            message: "Queued registry write lost its original database",
          });
        }
        await fixture.settle();
      });
      expect(ended).toHaveBeenCalledTimes(change === "current" ? 1 : 0);
      if (change === "source switched") {
        // Hook preparation handles authority loss best-effort; an earlier loss rejects the sweep.
        if (!outcome.completed) {
          expect(outcome.error).toMatchObject({
            message: "Queued registry write lost its original database",
          });
        }
        expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
      } else {
        expect(outcome).toEqual({ completed: true });
        if (change === "yielded") {
          expect(currentRun(runId)).toEqual(pausedRecord);
          expect(storedAnnouncement(runId)?.pauseReason).toBe("sessions_yield");
        }
      }
      if (change !== "yielded") {
        expect(currentRun(runId)?.delivery?.status).toBe("discarded");
      }
      expect(currentRun(runId)?.endedHookEmittedAt).toEqual(
        change === "current" ? expect.any(Number) : undefined,
      );
    } finally {
      waitResult.resolve({ status: "pending" });
      release.resolve();
      preparingHook.mockRestore();
      try {
        await Promise.allSettled([sweeping]);
      } finally {
        setTestEnvValue("OPENCLAW_STATE_DIR", fixture.stateDir);
      }
    }
  },
);

it.each([false, true])(
  "preserves registered suspended retirement across successor registration (successor: %s)",
  async (replace) => {
    const run = await registerCompletion("suspended-retirement", {
      cleanup: "delete",
      holdForRequester: true,
    });
    completeRegistered(run);
    await fixture.settle();
    await suspendRun(run.runId);
    const entry = currentRun(run.runId)!;
    const ended = vi.fn(async () => {});
    installEndedHook(ended);

    const context = createContext();
    context.localEmbedded = true;
    context.getRuntimeConfig = getRuntimeConfig;
    const resolveGatewayContext = () => context;
    context.resolveGatewayContext = resolveGatewayContext;
    const client = createOperatorClient({
      profileName: "retirement-successor",
      scopes: ["operator.write"],
    });
    const source = await captureGatewayOperatorRunAuthority({ client, context });
    if (!source) {
      throw new Error("Expected canonical successor authority");
    }
    client.internal = { operatorRunAuthority: source.authority };
    const cleanupEntered = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const removeAttachments = registryHelpers.safeRemoveAttachmentsDir;
    const cleanup = vi
      .spyOn(registryHelpers, "safeRemoveAttachmentsDir")
      .mockImplementation(async (retired, isCurrent) => {
        if (replace && getSubagentRunRuntimeKey(retired) === getSubagentRunRuntimeKey(entry)) {
          cleanupEntered.resolve();
          await releaseCleanup.promise;
        }
        return removeAttachments(retired, isCurrent);
      });
    const { ready, release, worker } = holdAnnouncementCommand(
      (command) =>
        isSubagentRegistryWriteCommand(command) && command.input.deleteRunIds.includes(run.runId),
      true,
    );
    const sweeping = testing.sweepOnceForTests();
    const outcome = sweeping.then(
      () => ({ completed: true as const }),
      (error: unknown) => ({ completed: false as const, error }),
    );
    const registerRetirementSuccessor = () =>
      withPluginRuntimeGatewayRequestScope(
        { client, context, resolveGatewayContext, isWebchatConnect: () => false },
        () =>
          registerSuccessor(entry, "live retirement successor", { expectsCompletionMessage: true }),
      );
    let successor = entry;
    let rejectedRegistration: Promise<unknown> | undefined;
    let registration: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(
        ready.promise,
        outcome,
        "Registered retirement omitted its acknowledgement boundary",
      );
      expect(currentRun(run.runId)).toBe(entry);
      expect(entry.delivery?.status).toBe("suspended");
      expect(loadSubagentRegistryFromSqlite().has(run.runId)).toBe(false);
      expect(ended).not.toHaveBeenCalled();
      if (replace) {
        rejectedRegistration = registerRetirementSuccessor().then(
          () => undefined,
          (error: unknown) => error,
        );
      }
      const publicationRevision = getSubagentRegistryPublicationRevision();
      release.resolve();
      if (replace) {
        await awaitGateBeforeSettlement(
          cleanupEntered.promise,
          outcome,
          "Suspended retirement settled before attachment cleanup entered",
        );
        const rejection = await rejectedRegistration;
        expect(rejection).toBeInstanceOf(SubagentRegistryMutationRejectedError);
        expect(rejection).toHaveProperty(
          "message",
          "Subagent registration owner changed during preparation",
        );
        expect(subagentRuns.has(run.runId)).toBe(false);
        expect(loadSubagentRegistryFromSqlite().has(run.runId)).toBe(false);
        registration = registerRetirementSuccessor();
      }
      await registration;
      if (replace) {
        successor = currentRun(run.runId)!;
      }
      releaseCleanup.resolve();
      const result = await outcome;
      await fixture.settle();
      if (replace) {
        expect(result).toEqual({
          completed: false,
          error: new Error("Subagent suspended delivery cleanup owner changed."),
        });
        expect(currentRun(run.runId)).toBe(successor);
        expect(storedAnnouncement(run.runId)?.task).toBe("live retirement successor");
        expect(getSubagentRegistryPublicationRevision()).toBeGreaterThan(publicationRevision);
        expect(ended).not.toHaveBeenCalled();
        subagentRuns.runWithCompletionAuthority(successor, () => {
          const retained =
            getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
          expect(retained?.source).toBe(source.authority.source);
          retained?.assertCurrent();
        });
      } else {
        expect(result).toEqual({ completed: true });
        expect(subagentRuns.has(run.runId)).toBe(false);
        expect(loadSubagentRegistryFromSqlite().has(run.runId)).toBe(false);
        expect(ended).toHaveBeenCalledOnce();
      }
    } finally {
      release.resolve();
      releaseCleanup.resolve();
      await Promise.allSettled([outcome, rejectedRegistration, registration]);
      cleanup.mockRestore();
      worker.mockRestore();
      source.release();
    }
  },
);
