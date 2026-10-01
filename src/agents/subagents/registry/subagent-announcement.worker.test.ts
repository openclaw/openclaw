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
import * as announceCleanup from "./subagent-registry-lifecycle-announce-cleanup.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getSubagentRegistryPublicationRevision } from "./subagent-registry-publication.js";
import * as registryState from "./subagent-registry-state.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import {
  registerSubagentRun,
  resumeSubagentRun,
  prepareSubagentSessionCleanupRevocation,
} from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import { testing } from "./subagent-registry.test-helpers.js";

vi.mock("../../../state/openclaw-state-worker-store.js", { spy: true });

vi.mock("./subagent-registry-lifecycle-announce-cleanup.js", { spy: true });

vi.mock("../../../plugins/hook-runner-global.js", { spy: true });

const fixture = useSubagentControlFixture();
const nativeState = await vi.importActual<typeof registryState>("./subagent-registry-state.js");

const nativeWorker = await vi.importActual<typeof stateWorker>(
  "../../../state/openclaw-state-worker-store.js",
);

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
  vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
    nativeState.persistSubagentRunsToDiskAsyncOrThrow,
  );
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
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation(async (context, operation, options) => {
        const selected =
          (!intercepted || change === "not-committed") &&
          entry.cleanupHandled === true &&
          entry.cleanupCompletedAt === undefined;
        if (!selected) {
          return nativeWorker.runOpenClawStateWorkerOperation(context, operation, options);
        }
        intercepted = true;
        ready.resolve();
        await release.promise;
        if (change === "not-committed") {
          throw new Error("Synthetic refused cleanup start");
        }
        return nativeWorker.runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            operation({
              async execute(command, executeOptions) {
                const result = await scope.execute(command, executeOptions);
                if (change === "unknown" && command.type === "subagents.persistChanges") {
                  committedBeforeLoss = true;
                  throw new SqliteWorkerError(
                    "Synthetic lost cleanup acknowledgement",
                    "outcome-unknown",
                  );
                }
                return result;
              },
            }),
          options,
        );
      });
    try {
      completeRegistered(run);
      await ready.promise;
      const before = loadSubagentRegistryFromSqlite().get(run.runId);
      expect(entry.cleanupHandled).toBe(true);
      expect(before?.cleanupHandled).not.toBe(true);
      expect(fixture.wake).not.toHaveBeenCalled();
      resumeSubagentRun(run.runId);
      if (change === "successor") {
        await registerSubagentRun({
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
      await fixture.settle();
      expect(fixture.wake).not.toHaveBeenCalled();
      expect(loadSubagentRegistryFromSqlite().get(run.runId)?.cleanupCompletedAt).toBeUndefined();
      if (change === "not-committed") {
        expect(entry.cleanupHandled).toBe(false);
        expect(loadSubagentRegistryFromSqlite().get(run.runId)).toEqual(before);
        worker.mockRestore();
        resumeSubagentRun(run.runId);
        await fixture.settle();
        expect(fixture.wake).toHaveBeenCalledOnce();
        expect(loadSubagentRegistryFromSqlite().get(run.runId)?.cleanupCompletedAt).toBeTypeOf(
          "number",
        );
      } else if (change === "unknown") {
        expect(entry.cleanupHandled).toBe(true);
        expect(committedBeforeLoss).toBe(true);
        const persisted = loadSubagentRegistryFromSqlite().get(run.runId)!;
        // Serialization clears the unfinished process lock; uncertain custody remains live.
        expect(persisted.cleanupHandled).toBe(false);
        expect(persisted.execution).toEqual(before?.execution);
        expect(persisted.completion).toEqual(before?.completion);
        resumeSubagentRun(run.runId);
        await fixture.settle();
        expect(fixture.wake).not.toHaveBeenCalled();
      } else {
        expect(subagentRuns.get(`${run.runId}-successor`)?.execution.status).toBe("running");
      }
    } finally {
      release.resolve();
      worker.mockRestore();
      await fixture.settle();
      if (change === "unknown") {
        await closeOpenClawStateDatabaseAsync();
        await nativeState.restoreSubagentRunsFromDisk({ runs: subagentRuns });
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
    vi.mocked(registryState.persistSubagentRunsToDiskOrThrow).mockImplementation(
      nativeState.persistSubagentRunsToDiskOrThrow,
    );
    const entry = subagentRuns.get(run.runId)!;
    entry.suppressCompletionDelivery = true;
    nativeState.persistSubagentRunsToDiskOrThrow(subagentRuns, [run.runId]);
    const before = loadSubagentRegistryFromSqlite().get(run.runId);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let closing: Promise<void> | undefined;
    let refused: unknown;
    const start = vi
      .spyOn(announceCleanup, "startSubagentAnnounceCleanupFlow")
      .mockImplementation((...args) => {
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
        if (phase !== "initial write" || !entry.cleanupHandled || closing) {
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
      let currentOwner = entry;
      if (publication === "replacement source") {
        await rename(replacementPath, databasePath);
        await nativeState.restoreSubagentRunsFromDisk({ runs: subagentRuns });
        expect(subagentRuns.get(run.runId)).toBe(entry);
        expect(loadSubagentRegistryFromSqlite().has(run.runId)).toBe(false);
      } else if (publication !== "none") {
        (await prepareSubagentSessionCleanupRevocation(run.childSessionKey))();
        expect(subagentRuns.get(run.runId)).toBe(entry);
        expect(
          loadSubagentRegistryFromSqlite().get(run.runId)?.execution.suppressSessionEffects,
        ).toBe(true);
        if (publication === "restored same-ID owner") {
          await nativeState.restoreSubagentRunsFromDisk({ runs: subagentRuns });
          currentOwner = subagentRuns.get(run.runId)!;
          expect(currentOwner).not.toBe(entry);
          expect(currentOwner.generation).toBe(entry.generation);
        }
      }
      const published = loadSubagentRegistryFromSqlite().get(run.runId);
      const ownerBeforeRelease = structuredClone(currentOwner);
      release.resolve();
      await joinWork(true);
      expect(refused).toBeInstanceOf(Error);
      expect(fixture.wake).not.toHaveBeenCalled();
      if (publication !== "none") {
        expect(subagentRuns.get(run.runId)).toBe(currentOwner);
        expect(currentOwner).toEqual(ownerBeforeRelease);
        expect(entry.cleanupHandled).toBe(true);
        expect(loadSubagentRegistryFromSqlite().get(run.runId)).toEqual(published);
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
      vi.mocked(registryState.persistSubagentRunsToDisk).mockImplementation(
        nativeState.persistSubagentRunsToDisk,
      );
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

    vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
      nativeState.persistSubagentRunsToDiskAsyncOrThrow,
    );

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

    const revokeSessionEffects = await prepareSubagentSessionCleanupRevocation(childSessionKey);
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
    entry.delivery = {
      ...entry.delivery,
      status: "suspended",
      suspendedAt: Date.now() - 8 * 24 * 60 * 60_000,
      suspendedReason: "expiry",
    };
    nativeState.persistSubagentRunsToDiskOrThrow(subagentRuns, [runId]);
    const ended = vi.fn(async () => {});
    const { registry, runner } = createHookRunnerWithRegistry([
      { hookName: "subagent_ended", handler: ended },
    ]);
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(registry);
    vi.spyOn(hookRuntime, "getGlobalHookRunner").mockReturnValue(runner);
    const ready = createDeferredCore();
    const release = createDeferredCore();
    let held = false;
    vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
      async (...args) => {
        const bookkeeping = !held && entry.delivery?.status === "discarded";
        await nativeState.persistSubagentRunsToDiskAsyncOrThrow(...args);
        if (bookkeeping) {
          held = true;
          ready.resolve();
          await release.promise;
        }
      },
    );
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
        revokeSessionEffects();
        expect(subagentRuns.get(runId)).toBe(entry);
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
        const stop = nativeState.onSubagentRegistryPersisted(() => {
          if (entry.pauseReason === "sessions_yield") {
            paused.resolve();
          }
        });
        try {
          waitResult.resolve({ status: "ok", yielded: true, endedAt: Date.now() });
          await paused.promise;
        } finally {
          stop();
        }
        expect(subagentRuns.get(runId)).toBe(registeredEntry);
        pausedRecord = structuredClone(entry);
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
        expect(outcome.completed).toBe(false);
        expect(entry).toEqual(pausedRecord);
        expect(loadSubagentRegistryFromSqlite().get(runId)?.pauseReason).toBe("sessions_yield");
      } else {
        expect(outcome).toEqual({ completed: true });
      }
      if (change !== "yielded") {
        expect(entry.delivery?.status).toBe("discarded");
      }
      if (change !== "current") {
        expect(entry.endedHookEmittedAt).toBeUndefined();
      } else {
        expect(entry.endedHookEmittedAt).toBeTypeOf("number");
      }
    } finally {
      waitResult.resolve({ status: "pending" });
      release.resolve();
      try {
        await Promise.allSettled([sweeping]);
      } finally {
        setTestEnvValue("OPENCLAW_STATE_DIR", fixture.stateDir);
      }
    }
  },
);

it.each([false, true])(
  "publishes registered suspended-delivery retirement only for its original row (successor: %s)",
  async (replace) => {
    const run = await registerCompletion("suspended-retirement", {
      cleanup: "delete",
      holdForRequester: true,
    });
    completeRegistered(run);
    await fixture.settle();
    const entry = subagentRuns.get(run.runId)!;
    expect(entry.execution.status).toBe("terminal");
    entry.delivery = {
      ...entry.delivery,
      status: "suspended",
      suspendedAt: Date.now() - 8 * 24 * 60 * 60_000,
      suspendedReason: "expiry",
    };
    nativeState.persistSubagentRunsToDiskOrThrow(subagentRuns, [run.runId]);
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
    let held = false;
    const worker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((stateContext, operation, options) => {
        const retiring = !held && entry.delivery?.status === "discarded";
        return nativeWorker.runOpenClawStateWorkerOperation(
          stateContext,
          (scope) =>
            operation({
              async execute(command, executeOptions) {
                const result = await scope.execute(command, executeOptions);
                if (retiring && command.type === "subagents.persistChanges") {
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
    let successor = entry;
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
        // Retaining this real source before the gate avoids queueing another reader behind it.
        await withPluginRuntimeGatewayRequestScope(
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
        successor = subagentRuns.get(run.runId)!;
        expect(successor).not.toBe(entry);
        expect(loadSubagentRegistryFromSqlite().get(run.runId)?.task).toBe(
          "live retirement successor",
        );
      }
      const publicationRevision = getSubagentRegistryPublicationRevision();
      release.resolve();
      const result = await outcome;
      await fixture.settle();
      if (replace) {
        expect(result).toMatchObject({
          completed: false,
          error: { outcome: "committed", publication: "superseded" },
        });
        expect(subagentRuns.get(run.runId)).toBe(successor);
        expect(loadSubagentRegistryFromSqlite().get(run.runId)?.task).toBe(
          "live retirement successor",
        );
        expect(getSubagentRegistryPublicationRevision()).toBe(publicationRevision);
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
      await outcome;
      worker.mockRestore();
      source.release();
    }
  },
);
