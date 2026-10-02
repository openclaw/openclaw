// Preserve fixture setup before production consumers.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { rename } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import * as hookRuntime from "../../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "../../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { setTestEnvValue } from "../../../test-utils/env.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
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
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import {
  registerSubagentRun,
  resumeSubagentRun,
  prepareSubagentSessionCleanupRevocation,
} from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import { testing } from "./subagent-registry.test-helpers.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

vi.mock("../../../state/openclaw-state-worker-store.js", { spy: true });

vi.mock("./subagent-registry-lifecycle-announce-cleanup.js", { spy: true });

vi.mock("../../../plugins/hook-runner-global.js", { spy: true });

const fixture = useSubagentControlFixture();

const nativeWorker = await vi.importActual<typeof stateWorker>(
  "../../../state/openclaw-state-worker-store.js",
);

async function updateRun(
  runId: string,
  edit: (draft: import("./subagent-registry.types.js").SubagentRunRecord) => void,
) {
  await mutateSubagentRuns([runId], (rows) => {
    const next = structuredClone(rows.get(runId)!);
    edit(next);
    return { value: undefined, postimages: new Map([[runId, next]]) };
  });
}

const nativeCleanup = await vi.importActual<typeof announceCleanup>(
  "./subagent-registry-lifecycle-announce-cleanup.js",
);

async function registerCompletion(
  runId: string,
  options: { holdForRequester?: boolean; cleanup?: "keep" | "delete" } = {},
) {
  const childSessionKey = `agent:main:subagent:${runId}`;
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childSessionKey,
    defaultSessionId: "ordinary-child-session",
    lifecycleRevision: "ordinary-child-revision",
  });
  fixture.capture.mockResolvedValue("Synthetic completed result.");
  fixture.wake.mockResolvedValue(false);
  await registerSubagentRun({
    runId,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "finish ordinary cleanup",
    cleanup: options.cleanup ?? "keep",
    expectsCompletionMessage: options.holdForRequester === true,
    completionTarget: options.holdForRequester ? "parent" : undefined,
    requesterTurnRunId: options.holdForRequester ? "held-requester-turn" : undefined,
  });
  return { runId, childSessionKey };
}

function completeRegistered(run: { runId: string; childSessionKey: string }) {
  emitAgentEvent({
    ...run,
    sessionKey: run.childSessionKey,
    stream: "lifecycle",
    data: {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "Synthetic completed result." },
    },
  });
}

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
        marker: loadSubagentRegistryFromSqlite().get(runId)?.deleteCleanupDispatchedAt,
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
      expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
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
    const entry = subagentRuns.get(run.runId)!;
    const ready = createDeferredCore();
    const release = createDeferredCore();
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
          return nativeWorker.runOpenClawStateWorkerOperation(context, operation, options);
        }
        intercepted = true;
        ready.resolve();
        await release.promise;
        if (change === "not-committed") {
          throw new Error("Synthetic refused cleanup start");
        }
        let admission: SqliteWorkerOperationAdmission | undefined;
        const createAdmission = options?.createAdmission;
        return nativeWorker.runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            operation({
              async execute(command, executeOptions) {
                const result = await scope.execute(command, executeOptions);
                if (change === "unknown" && command.type === "subagents.persistChanges") {
                  committedBeforeLoss = true;
                  admission?.service();
                  if (!admission?.committed) {
                    throw new Error("Cleanup start did not retain its native commit receipt");
                  }
                  Object.defineProperty(admission, "committed", { value: { facts: undefined } });
                  throw new SqliteWorkerError(
                    "Synthetic unreadable cleanup acknowledgement",
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
    let registration: Promise<void> | undefined;
    try {
      completeRegistered(run);
      await ready.promise;
      const before = loadSubagentRegistryFromSqlite().get(run.runId);
      expect(subagentRuns.get(run.runId)?.cleanupHandled).not.toBe(true);
      expect(cleanupContext?.cleanupReservations.has(getSubagentRunRuntimeKey(entry))).toBe(true);
      expect(before?.cleanupHandled).not.toBe(true);
      expect(fixture.wake).not.toHaveBeenCalled();
      resumeSubagentRun(run.runId);
      if (change === "successor") {
        registration = registerSubagentRun({
          runId: `${run.runId}-successor`,
          childSessionKey: run.childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterAgentId: "main",
          requesterDisplayKey: "main",
          task: "new child generation",
          cleanup: "keep",
          expectsCompletionMessage: false,
        });
      }
      release.resolve();
      await registration;
      await fixture.settle();
      if (change !== "successor") {
        expect(fixture.wake).not.toHaveBeenCalled();
        expect(loadSubagentRegistryFromSqlite().get(run.runId)?.cleanupCompletedAt).toBeUndefined();
      }
      if (change === "not-committed") {
        expect(subagentRuns.get(run.runId)?.cleanupHandled).not.toBe(true);
        expect(loadSubagentRegistryFromSqlite().get(run.runId)).toEqual(before);
        worker.mockRestore();
        resumeSubagentRun(run.runId);
        await fixture.settle();
        expect(fixture.wake).toHaveBeenCalledOnce();
        expect(loadSubagentRegistryFromSqlite().get(run.runId)?.cleanupCompletedAt).toBeTypeOf(
          "number",
        );
      } else if (change === "unknown") {
        expect(subagentRuns.get(run.runId)?.cleanupHandled).not.toBe(true);
        expect(committedBeforeLoss).toBe(true);
        const persisted = loadSubagentRegistryFromSqlite().get(run.runId)!;
        // Unknown receipt custody fences the row without publishing a speculative lock.
        expect(persisted.cleanupHandled).toBe(false);
        expect(persisted.execution).toEqual(before?.execution);
        expect(persisted.completion).toEqual(before?.completion);
        resumeSubagentRun(run.runId);
        await fixture.settle();
        expect(fixture.wake).not.toHaveBeenCalled();
      } else {
        expect(fixture.wake).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            settledEntry: expect.objectContaining({ runId: run.runId }),
          }),
        );
        expect(loadSubagentRegistryFromSqlite().get(run.runId)).toMatchObject({
          cleanupCompletedAt: expect.any(Number),
          execution: { status: "terminal", suppressSessionEffects: true },
        });
        expect(subagentRuns.get(`${run.runId}-successor`)?.execution.status).toBe("running");
      }
    } finally {
      release.resolve();
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

it.each([
  { phase: "capture", publication: "none" },
  { phase: "initial write", publication: "none" },
  { phase: "initial write", publication: "same-row reservation" },
  { phase: "initial write", publication: "restored same-ID owner" },
  { phase: "initial write", publication: "replacement source" },
] as const)(
  "retains exact cleanup custody after source refusal ($phase, $publication)",
  async ({ phase, publication }) => {
    const joinWork = observeRootWork();
    const run = await registerCompletion("sealed-cleanup-start", {
      holdForRequester: true,
    });
    completeRegistered(run);
    await joinWork(true);
    await fixture.settle();
    const databasePath = captureOpenClawStateWorkerContext().admission.databasePath;
    const replacementPath = path.join(fixture.stateDir, "replacement.sqlite");
    if (publication === "replacement source") {
      openOpenClawStateDatabase({ path: replacementPath });
      await closeOpenClawStateDatabaseByPathAsync(replacementPath);
    }
    const entry = subagentRuns.get(run.runId)!;
    await mutateSubagentRuns([run.runId], (rows) => ({
      value: undefined,
      postimages: new Map([
        [run.runId, { ...rows.get(run.runId)!, suppressCompletionDelivery: true }],
      ]),
    }));
    const before = loadSubagentRegistryFromSqlite().get(run.runId);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let closing: Promise<void> | undefined;
    let refused: unknown;
    let cleanupContext:
      | Parameters<typeof nativeCleanup.startSubagentAnnounceCleanupFlow>[0]
      | undefined;
    const start = vi
      .spyOn(announceCleanup, "startSubagentAnnounceCleanupFlow")
      .mockImplementation((...args) => {
        cleanupContext = args[0];
        if (phase !== "capture") {
          return nativeCleanup.startSubagentAnnounceCleanupFlow(...args);
        }
        closing ??= closeOpenClawStateDatabaseAsync();
        try {
          return nativeCleanup.startSubagentAnnounceCleanupFlow(...args);
        } catch (error) {
          refused = error;
          throw error;
        } finally {
          entered.resolve();
        }
      });
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation(async (...args) => {
        if (
          phase !== "initial write" ||
          !cleanupContext?.cleanupReservations.has(getSubagentRunRuntimeKey(entry)) ||
          closing
        ) {
          return nativeWorker.runOpenClawStateWorkerOperation(...args);
        }
        closing = closeOpenClawStateDatabaseAsync();
        try {
          return await nativeWorker.runOpenClawStateWorkerOperation(...args);
        } catch (error) {
          refused = error;
          entered.resolve();
          await release.promise;
          throw error;
        } finally {
          entered.resolve();
        }
      });
    try {
      if (phase === "capture") {
        expect(() => resumeSubagentRun(run.runId)).toThrow(
          "state database read admission is closed",
        );
      } else {
        resumeSubagentRun(run.runId);
      }
      await entered.promise;
      await closing;
      let publicationWork: Promise<unknown> | undefined;
      if (publication === "replacement source") {
        await rename(replacementPath, databasePath);
        publicationWork = restoreSubagentRunsFromDisk({ runs: subagentRuns });
      } else if (publication !== "none") {
        publicationWork = (async () => {
          (await prepareSubagentSessionCleanupRevocation(run.childSessionKey))();
          if (publication === "restored same-ID owner") {
            await restoreSubagentRunsFromDisk({ runs: subagentRuns });
          }
        })();
      }
      release.resolve();
      await joinWork(true);
      await publicationWork;
      const currentOwner = subagentRuns.get(run.runId);
      const published = loadSubagentRegistryFromSqlite().get(run.runId);
      expect(refused).toBeInstanceOf(Error);
      expect(fixture.wake).not.toHaveBeenCalled();
      if (publication !== "none") {
        if (publication === "replacement source") {
          expect(published).toBeUndefined();
        } else {
          expect(currentOwner?.execution.suppressSessionEffects).toBe(true);
          expect(published?.execution.suppressSessionEffects).toBe(true);
        }
        expect(entry.cleanupHandled).not.toBe(true);
        expect(fixture.announce).not.toHaveBeenCalled();
        return;
      }
      expect(entry.cleanupHandled).not.toBe(true);
      expect(loadSubagentRegistryFromSqlite().get(run.runId)).toEqual(before);
      expect(fixture.wake).not.toHaveBeenCalled();
      start.mockRestore();
      worker.mockRestore();
      resumeSubagentRun(run.runId);
      await joinWork(true);
      await fixture.settle();
      expect(loadSubagentRegistryFromSqlite().get(run.runId)?.cleanupCompletedAt).toBeTypeOf(
        "number",
      );
      expect(fixture.announce).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      start.mockRestore();
      worker.mockRestore();
      await joinWork();
      await closing;
    }
  },
);

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
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      requesterTurnRunId: "held-parent-turn",
      completionTarget: "parent",
      task: "discard a suspended result without stale hook effects",
      cleanup: "keep",
      retainAttachmentsOnKeep: true,
      expectsCompletionMessage: true,
    });
    const registeredEntry = subagentRuns.get(runId);

    if (change === "yielded") {
      await waitStarted.promise;
    }

    const settleCompletion = observeRootWork();
    try {
      emitAgentEvent({
        runId,
        sessionKey: childSessionKey,
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: Date.now(),
          terminalReply: { disposition: "visible", text: "Suspended synthetic result." },
        },
      });
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
    const entry = subagentRuns.get(runId)!;
    let pausedRecord: typeof entry | undefined;
    expect(entry.execution.status).toBe("terminal");
    expect(entry.endedHookEmittedAt).toBeUndefined();
    await updateRun(runId, (draft) => {
      draft.delivery = {
        ...draft.delivery,
        status: "suspended",
        suspendedAt: Date.now() - 8 * 24 * 60 * 60_000,
        suspendedReason: "expiry",
      };
    });
    const ended = vi.fn(async () => {});
    const { registry, runner } = createHookRunnerWithRegistry([
      { hookName: "subagent_ended", handler: ended },
    ]);
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(registry);
    vi.spyOn(hookRuntime, "getGlobalHookRunner").mockReturnValue(runner);
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

      expect(loadSubagentRegistryFromSqlite().get(runId)?.cleanupCompletedAt).toBeTypeOf("number");
      expect(ended).not.toHaveBeenCalled();
      if (change === "revoked") {
        (await prepareSubagentSessionCleanupRevocation(childSessionKey))();
        expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.suppressSessionEffects).toBe(
          true,
        );
      }
      if (change === "source switched") {
        setTestEnvValue("OPENCLAW_STATE_DIR", replacementDir);
        expect(() => originalSource.admission.assertCurrent()).not.toThrow();
      }
      if (change === "yielded") {
        const paused = createDeferredCore();
        const stop = subscribeSubagentRunChanges("persistence", () => {
          if (subagentRuns.get(runId)?.pauseReason === "sessions_yield") {
            paused.resolve();
          }
        });
        try {
          waitResult.resolve({ status: "ok", yielded: true, endedAt: Date.now() });
          await paused.promise;
        } finally {
          stop();
        }
        expect(subagentRuns.get(runId)?.generation).toBe(registeredEntry?.generation);
        pausedRecord = structuredClone(subagentRuns.get(runId)!);
        expect(loadSubagentRegistryFromSqlite().get(runId)?.pauseReason).toBe("sessions_yield");
      }
      release.resolve();
      const outcome = await sweepOutcome;
      await fixture.settle();
      expect(ended).toHaveBeenCalledTimes(change === "current" ? 1 : 0);
      if (change === "source switched") {
        expect(outcome).toMatchObject({
          completed: false,
          error: { message: "Queued registry write lost its original database" },
        });
        expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
      } else if (change === "yielded") {
        expect(outcome).toEqual({ completed: true });
        expect(subagentRuns.get(runId)).toEqual(pausedRecord);
        expect(loadSubagentRegistryFromSqlite().get(runId)?.pauseReason).toBe("sessions_yield");
      } else {
        expect(outcome).toEqual({ completed: true });
      }
      if (change !== "yielded") {
        expect(subagentRuns.get(runId)?.delivery?.status).toBe("discarded");
      }
      if (change !== "current") {
        expect(subagentRuns.get(runId)?.endedHookEmittedAt).toBeUndefined();
      } else {
        expect(subagentRuns.get(runId)?.endedHookEmittedAt).toBeTypeOf("number");
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
    let entry = subagentRuns.get(run.runId)!;
    expect(entry.execution.status).toBe("terminal");
    await updateRun(run.runId, (draft) => {
      draft.delivery = {
        ...draft.delivery,
        status: "suspended",
        suspendedAt: Date.now() - 8 * 24 * 60 * 60_000,
        suspendedReason: "expiry",
      };
    });
    entry = subagentRuns.get(run.runId)!;
    const ended = vi.fn(async () => {});
    const { registry, runner } = createHookRunnerWithRegistry([
      { hookName: "subagent_ended", handler: ended },
    ]);
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(registry);
    vi.spyOn(hookRuntime, "getGlobalHookRunner").mockReturnValue(runner);

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
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((stateContext, operation, options) => {
        return nativeWorker.runOpenClawStateWorkerOperation(
          stateContext,
          (scope) =>
            operation({
              async execute(command, executeOptions) {
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
            }),
          options,
        );
      });
    const sweeping = testing.sweepOnceForTests();
    const outcome = sweeping.then(
      () => ({ completed: true as const }),
      (error: unknown) => ({ completed: false as const, error }),
    );
    const registerSuccessor = () =>
      withPluginRuntimeGatewayRequestScope(
        { client, context, resolveGatewayContext, isWebchatConnect: () => false },
        () =>
          registerSubagentRun({
            runId: run.runId,
            childSessionKey: run.childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterAgentId: "main",
            requesterDisplayKey: "main",
            task: "live retirement successor",
            cleanup: "keep",
            expectsCompletionMessage: true,
          }),
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
      expect(subagentRuns.get(run.runId)).toBe(entry);
      expect(entry.delivery?.status).toBe("suspended");
      expect(loadSubagentRegistryFromSqlite().has(run.runId)).toBe(false);
      expect(ended).not.toHaveBeenCalled();
      if (replace) {
        rejectedRegistration = registerSuccessor().then(
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
        registration = registerSuccessor();
      }
      await registration;
      if (replace) {
        successor = subagentRuns.get(run.runId)!;
      }
      releaseCleanup.resolve();
      const result = await outcome;
      await fixture.settle();
      if (replace) {
        expect(result).toEqual({
          completed: false,
          error: new Error("Subagent suspended delivery cleanup owner changed."),
        });
        expect(subagentRuns.get(run.runId)).toBe(successor);
        expect(loadSubagentRegistryFromSqlite().get(run.runId)?.task).toBe(
          "live retirement successor",
        );
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
