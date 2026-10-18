// Preserve fixture setup before production consumers.
// oxfmt-ignore
import { runSubagentStateWorkerOperation as runWorker, useSubagentControlFixture } from "./subagent-control.test-support.js";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { setTestEnvValue } from "../../../test-utils/env.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import {
  announcementFixture,
  completeRegistered,
  currentRun,
  installEndedHook,
  registrationDefaults,
  registerSuccessor,
  storedAnnouncement,
  suspendRun,
  updateRun,
  withUnreadableReceipt,
} from "./subagent-announcement.test-support.js";
import * as registryDeps from "./subagent-registry-deps.js";
import * as registryHelpers from "./subagent-registry-helpers.js";
import * as announceCleanup from "./subagent-registry-lifecycle-announce-cleanup.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import {
  getSubagentRegistryPublicationRevision,
  subscribeSubagentRunChanges,
} from "./subagent-registry-publication.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import {
  registerSubagentRun,
  resumeSubagentRun,
  prepareSubagentSessionCleanupRevocation,
} from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
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

it.each(["keep", "delete"] as const)(
  "settles registered quiet %s completion without host registry writes",
  async (cleanup) => {
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
    const registryWrites: string[] = [];
    let statements: ReturnType<typeof observeHostDataSql> | undefined;
    // Terminal admission precedes browser cleanup. Measure ordinary cleanup through
    // its awaited registry bookkeeping; requester batch transport stays mocked.
    fixture.cleanup.mockImplementation(async () => {
      statements = observeHostDataSql((sql) => {
        if (/(?:insert into|update|delete from)\s+"?subagent_runs\b/i.test(sql)) {
          registryWrites.push(sql);
        }
      });
    });
    try {
      completeRegistered(run);
      await fixture.settle();
      expect(storedAnnouncement(runId)).toMatchObject({
        cleanupCompletedAt: expect.any(Number),
        execution: { status: "terminal", outcome: { status: "ok" } },
        delivery: { status: "not_required" },
      });
      expect(fixture.cleanup).toHaveBeenCalledOnce();
      expect(statements).toBeDefined();
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
      expect(registryWrites.length).toBe(0);
    } finally {
      statements?.restore();
    }
  },
);

it.each(["not-committed", "unknown", "successor"] as const)(
  "retains registered cleanup admission while its start waits (%s)",
  async (change) => {
    const run = await registerCompletion(`cleanup-start-${change}`);
    const entry = currentRun(run.runId)!;
    const unreadableReceiptFailure = {
      name: "AggregateError",
      message: "Failed to settle subagent cleanup roots",
      errors: [
        {
          name: "SubagentRegistryCommitReceiptError",
          outcome: "committed",
          cause: { code: "outcome-unknown", message: "Committed registry receipt is unreadable" },
        },
      ],
    };
    const ready = createDeferredCore();
    const release = createDeferredCore();
    const successorQueued = createDeferredCore();
    const mutation = vi.mocked(mutateSubagentRuns).mockImplementation((runIds, plan, options) => {
      const pending = nativePersistence.mutateSubagentRuns(runIds, plan, options);
      if (runIds.includes(`${run.runId}-successor`)) {
        successorQueued.resolve();
      }
      return pending;
    });
    let intercepted = false;
    let committedBeforeLoss = false;
    let cleanupContext:
      | Parameters<typeof nativeCleanup.startSubagentAnnounceCleanupFlow>[0]
      | undefined;
    const start = vi
      .spyOn(announceCleanup, "startSubagentAnnounceCleanupFlow")
      .mockImplementation((context, ...args) => {
        cleanupContext = context;
        return nativeCleanup.startSubagentAnnounceCleanupFlow(context, ...args);
      });
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation(async (context, operation, options) => {
        const selected =
          (!intercepted || change === "not-committed") &&
          cleanupContext?.cleanupReservations.has(getSubagentRunRuntimeKey(entry));
        if (!selected) {
          return runWorker(context, operation, options);
        }
        intercepted = true;
        ready.resolve();
        await release.promise;
        if (change === "not-committed") {
          throw new Error("Synthetic refused cleanup start");
        }
        return withUnreadableReceipt(
          runWorker,
          context,
          operation,
          options,
          (command) => change === "unknown" && command.type === "subagents.persistChanges",
          () => {
            committedBeforeLoss = true;
          },
        );
      });
    let registration: Promise<void> | undefined;
    try {
      completeRegistered(run);
      await ready.promise;
      const before = storedAnnouncement(run.runId);
      expect(currentRun(run.runId)?.cleanupHandled).not.toBe(true);
      expect(cleanupContext?.cleanupReservations.has(getSubagentRunRuntimeKey(entry))).toBe(true);
      expect(before?.cleanupHandled).not.toBe(true);
      expect(fixture.wake).not.toHaveBeenCalled();
      resumeSubagentRun(run.runId);
      if (change === "successor") {
        registration = registerSuccessor(entry, "new child generation", {
          runId: `${run.runId}-successor`,
        });
        await successorQueued.promise;
      }
      release.resolve();
      await registration;
      if (change === "unknown") {
        await expect(fixture.settle()).rejects.toMatchObject(unreadableReceiptFailure);
      } else {
        await fixture.settle();
      }
      if (change !== "successor") {
        expect(fixture.wake).not.toHaveBeenCalled();
        expect(storedAnnouncement(run.runId)?.cleanupCompletedAt).toBeUndefined();
      }
      if (change === "not-committed") {
        expect(currentRun(run.runId)?.cleanupHandled).not.toBe(true);
        expect(storedAnnouncement(run.runId)).toEqual(before);
        worker.mockRestore();
        resumeSubagentRun(run.runId);
        await fixture.settle();
        expect(fixture.wake).toHaveBeenCalledOnce();
        expect(storedAnnouncement(run.runId)?.cleanupCompletedAt).toBeTypeOf("number");
      } else if (change === "unknown") {
        expect(currentRun(run.runId)?.cleanupHandled).not.toBe(true);
        expect(committedBeforeLoss).toBe(true);
        const persisted = storedAnnouncement(run.runId)!;
        // Unknown receipt custody fences the row without publishing a speculative lock.
        expect(persisted.cleanupHandled).toBe(false);
        expect(persisted.execution).toEqual(before?.execution);
        expect(persisted.completion).toEqual(before?.completion);
        const nativeCalls = worker.mock.calls.length;
        resumeSubagentRun(run.runId);
        await expect(fixture.settle()).rejects.toMatchObject(unreadableReceiptFailure);
        expect(worker).toHaveBeenCalledTimes(nativeCalls);
        expect(fixture.wake).not.toHaveBeenCalled();
      } else {
        expect(fixture.wake).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            settledEntry: expect.objectContaining({ runId: run.runId }),
          }),
        );
        expect(storedAnnouncement(run.runId)).toMatchObject({
          cleanupCompletedAt: expect.any(Number),
          execution: { status: "terminal", suppressSessionEffects: true },
        });
        expect(currentRun(`${run.runId}-successor`)?.execution.status).toBe("running");
      }
    } finally {
      release.resolve();
      mutation.mockRestore();
      worker.mockRestore();
      start.mockRestore();
      await registration;
      await fixture.settle();
      if (change === "unknown") {
        await closeOpenClawStateDatabaseAsync();
        await restoreSubagentRunsFromDisk({ runs: subagentRuns });
      }
    }
  },
);

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
    const childSessionKey = `agent:main:subagent:${runId}`;
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: "suspended-child-session",
      lifecycleRevision: "suspended-child-revision",
    });
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
    await registerSubagentRun({
      ...registrationDefaults,
      runId,
      childSessionKey,
      sessionEntry: {
        sessionId: "suspended-child-session",
        lifecycleRevision: "suspended-child-revision",
      },
      requesterTurnRunId: "held-parent-turn",
      completionTarget: "parent",
      task: "discard a suspended result without stale hook effects",
      retainAttachmentsOnKeep: true,
      expectsCompletionMessage: true,
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
    const entry = currentRun(runId)!;
    let pausedRecord: typeof entry | undefined;
    expect(entry.execution.status).toBe("terminal");
    expect(entry.endedHookEmittedAt).toBeUndefined();
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
      } else if (change === "yielded") {
        expect(outcome).toEqual({ completed: true });
        expect(currentRun(runId)).toEqual(pausedRecord);
        expect(storedAnnouncement(runId)?.pauseReason).toBe("sessions_yield");
      } else {
        expect(outcome).toEqual({ completed: true });
      }
      if (change !== "yielded") {
        expect(currentRun(runId)?.delivery?.status).toBe("discarded");
      }
      if (change !== "current") {
        expect(currentRun(runId)?.endedHookEmittedAt).toBeUndefined();
      } else {
        expect(currentRun(runId)?.endedHookEmittedAt).toBeTypeOf("number");
      }
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
    let entry = currentRun(run.runId)!;
    expect(entry.execution.status).toBe("terminal");
    await suspendRun(run.runId);
    entry = currentRun(run.runId)!;
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
    const ready = createDeferredCore();
    const release = createDeferredCore();
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
    let held = false;
    const worker = probe.command(
      stateWorker,
      async (command, executeOptions, scope) => {
        const result = await scope.execute(command, executeOptions);
        if (
          !held &&
          isSubagentRegistryWriteCommand(command) &&
          command.input.deleteRunIds.includes(run.runId)
        ) {
          held = true;
          // The real transaction has settled; only its host acknowledgement waits.
          ready.resolve();
          await release.promise;
        }
        return result;
      },
      { original: runWorker },
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
      await Promise.race([
        ready.promise,
        outcome.then(() => {
          throw new Error("Registered retirement omitted its acknowledgement boundary");
        }),
      ]);
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
        await Promise.race([
          cleanupEntered.promise,
          outcome.then(() => {
            throw new Error("Suspended retirement settled before attachment cleanup entered");
          }),
        ]);
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
