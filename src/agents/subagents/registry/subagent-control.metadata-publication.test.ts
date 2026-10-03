// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { withSessionEntryWorker } from "../../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import * as sessionGeneration from "../../../config/sessions/session-delivery-generation.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { runOutsideAsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as writerQueue from "../../../shared/store-writer-queue.js";
import { releaseOpenClawAgentDatabaseReadValidation } from "../../../state/openclaw-agent-db-validation-cache.js";
import type { AgentDatabaseExecutionScope } from "../../../state/openclaw-agent-execution-contract.js";
import * as executionOwner from "../../../state/openclaw-agent-execution.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../../state/openclaw-agent-write-admission.js";
import { enqueueSwarmRun, isSwarmRunActive } from "../swarm/swarm-scheduler.js";
import * as killScopeOwner from "./subagent-control-kill-scope.js";
import * as controlSession from "./subagent-control-session.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();

it.for([
  { replacement: false, competingIdle: false, publication: "tombstone" },
  { replacement: true, competingIdle: false, publication: "tombstone" },
  { replacement: false, competingIdle: true, publication: "tombstone" },
  { replacement: false, competingIdle: false, publication: "result" },
  { replacement: true, competingIdle: false, publication: "result" },
  { replacement: false, competingIdle: false, publication: "discovery" },
])(
  "joins a pending session publication before cancellation $publication (replacement=$replacement, competing idle=$competingIdle)",
  async ({ replacement, competingIdle, publication }, { signal }) => {
    const parentKey = "agent:main:main";
    const childKey = "agent:main:subagent:pending-kill-publication";
    const runId = "pending-kill-publication";
    const sessionId = "pending-kill-publication-session";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childKey,
      defaultSessionId: sessionId,
    });
    await registerSubagentRun({
      runId,
      childSessionKey: childKey,
      requesterSessionKey: parentKey,
      requesterAgentId: "main",
      requesterDisplayKey: parentKey,
      task: "held metadata publication",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    let peerExecution:
      | ReturnType<typeof executionOwner.captureOpenClawAgentDatabaseExecution>
      | undefined;
    let childPhysicalPath: string | undefined;
    if (competingIdle) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "idle-peer",
        sessionKey: "agent:idle-peer:subagent:retained-execution",
        defaultSessionId: "retained-peer-execution-session",
      });
      const prepareExecution = async (agentId: string) => {
        const retained = executionOwner.captureOpenClawAgentDatabaseExecution({
          agentId,
          env: process.env,
        });
        onTestFinished(() => retained.release());
        await withSessionEntryWorker(
          { agentId, path: retained.path, env: process.env },
          undefined,
          () => retained.assertCurrent(),
          (execution, source) => execution.prepare(source),
          undefined,
          retained,
        );
        retained.captureGenerationClaim().assertCurrent();
        return retained;
      };
      peerExecution = await prepareExecution("idle-peer");
      // Start with the child's original executor idle and the peer still borrowed.
      // The later peer release must cause eviction, not this fixture preparation.
      const childExecution = await prepareExecution("main");
      childPhysicalPath = childExecution.path;
      await childExecution.release();
    }
    const producerScope = new AsyncLocalStorage<boolean>();
    const killScope = new AsyncLocalStorage<boolean>();
    const nativeHeld = createDeferredCore();
    const releaseNative = createDeferredCore();
    let producerPath: string | undefined;
    let holdingResult = false;
    let joinedPublication = false;
    let peerReleasedDuringPublication = false;
    let producer: Promise<void> | undefined;
    let producerOutcome: Promise<unknown> | undefined;
    const release = () => releaseNative.resolve();
    signal.addEventListener("abort", release, { once: true });
    if (publication === "discovery") {
      const prepareGeneration = sessionGeneration.prepareSessionGenerationFacts;
      vi.spyOn(sessionGeneration, "prepareSessionGenerationFacts").mockImplementation(
        async (input) => {
          const facts = await prepareGeneration(input);
          return {
            ...facts,
            assertCurrent: () => {
              // Let the native writer settle after this synchronous observation.
              // An unprepared discovery still sees the genuinely pending publication.
              if (holdingResult) {
                release();
              }
              facts.assertCurrent();
            },
            prepareRead: () => {
              const pending = facts.prepareRead();
              if (holdingResult && pending) {
                joinedPublication = true;
                release();
              }
              return pending;
            },
          };
        },
      );
    }
    const runQueued = writerQueue.runQueuedStoreWrite;
    vi.spyOn(writerQueue, "runQueuedStoreWrite").mockImplementation((params) => {
      if (params.queues !== SQLITE_SESSION_WRITER_QUEUES) {
        return runQueued(params);
      }
      if (producerScope.getStore()) {
        producerPath ??= params.storePath;
      }
      const joining =
        killScope.getStore() &&
        !producerScope.getStore() &&
        holdingResult &&
        params.storePath === producerPath;
      const before = joining
        ? new Set(params.queues.get(params.storePath)?.pending ?? [])
        : undefined;
      const result = runQueued(params);
      if (
        before &&
        params.queues.get(params.storePath)?.pending.some((entry) => !before.has(entry))
      ) {
        joinedPublication = true;
        release();
      }
      return result;
    });
    const captureExecution = executionOwner.captureOpenClawAgentDatabaseExecution;
    vi.spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution").mockImplementation(
      (...args) => {
        const execution = captureExecution(...args);
        if (!producerScope.getStore()) {
          return execution;
        }
        const runExisting: typeof execution.runExisting = (source, operation, options) =>
          execution.runExisting(
            source,
            (scope) => {
              const wrapped: AgentDatabaseExecutionScope = {
                execute(command, commandOptions) {
                  const pending = scope.execute(command, commandOptions);
                  if (command.type !== "session.entries.replace" || holdingResult) {
                    return pending;
                  }
                  holdingResult = true;
                  return pending.then(async (value) => {
                    if (peerExecution) {
                      // Read-cache cleanup may drop transferable validation without retiring
                      // the live native writer. Reopening then requires registration again.
                      releaseOpenClawAgentDatabaseReadValidation([{ path: childPhysicalPath! }]);
                      // Occupy the idle slot while the child's native writer is still borrowed.
                      await peerExecution.release();
                      peerReleasedDuringPublication = true;
                    }
                    nativeHeld.resolve();
                    await releaseNative.promise;
                    return value;
                  });
                },
              };
              return operation(wrapped);
            },
            options,
          );
        return new Proxy(execution, {
          get(original, key, receiver) {
            return key === "runExisting" ? runExisting : Reflect.get(original, key, receiver);
          },
        });
      },
    );
    const startProducer = async () => {
      if (!producer) {
        producer = runOutsideAsyncWorkScope(() =>
          runWithGatewayIndependentRootWorkAdmission(
            () =>
              producerScope.run(true, () =>
                applySessionEntryExactReplacements({
                  agentId: "main",
                  storePath,
                  sessionKeys: [childKey],
                  activeSessionKey: childKey,
                  skipMaintenance: true,
                  requireWriteSuccess: true,
                  update(entries) {
                    const row = entries.find((entry) => entry.sessionKey === childKey);
                    if (!row || row.entry.sessionId !== sessionId) {
                      throw new Error("Metadata producer lost its child");
                    }
                    return {
                      result: undefined,
                      replacements: [
                        {
                          sessionKey: childKey,
                          entry: {
                            ...row.entry,
                            sessionId: replacement ? `${sessionId}-replacement` : sessionId,
                            label: "metadata survived",
                          },
                        },
                      ],
                    };
                  },
                }),
              ),
            "test:kill-pending-metadata",
            signal,
          ),
        );
        producerOutcome = producer.then(
          () => ({ ok: true }),
          (error: unknown) => ({ error }),
        );
        await awaitGateBeforeSettlement(
          nativeHeld.promise,
          producer,
          "Metadata publication was not held",
        );
      }
    };
    const acquire = vi.spyOn(
      SubagentLifecycleController.prototype,
      "acquireTerminalCompletionLock",
    );
    acquire.mockRestore();
    vi.spyOn(
      SubagentLifecycleController.prototype,
      "acquireTerminalCompletionLock",
    ).mockImplementation(async function (this: SubagentLifecycleController, targetRunId) {
      const unlock = await acquire.call(this, targetRunId);
      if (publication === "tombstone" && targetRunId === runId) {
        await startProducer();
      }
      return unlock;
    });
    const withKillScope = killScopeOwner.withSubagentKillScope;
    vi.spyOn(killScopeOwner, "withSubagentKillScope").mockImplementation(
      (params, run, captureResult, preparePublication, finishResult) =>
        withKillScope(
          params,
          async (scope, trees) => {
            const result = await run(
              publication === "discovery"
                ? {
                    ...scope,
                    refresh: async () => {
                      if (subagentRuns.get(runId)?.execution.status === "terminal") {
                        await startProducer();
                      }
                      return scope.refresh();
                    },
                  }
                : scope,
              trees,
            );
            if (publication === "result") {
              expect(subagentRuns.get(runId)).toMatchObject({
                endedReason: "subagent-killed",
                execution: { status: "terminal" },
              });
              await startProducer();
            }
            return result;
          },
          captureResult,
          preparePublication,
          finishResult,
        ),
    );
    const onResult = vi.fn();
    try {
      const result = await killScope
        .run(true, () =>
          publication === "result"
            ? killSubagentRunAdmin({
                cfg: getRuntimeConfig(),
                sessionKey: childKey,
                agentId: "main",
                expectedRunId: runId,
                onResult,
              })
            : killAllControlledSubagentRuns({
                cfg: getRuntimeConfig(),
                controller: {
                  controllerSessionKey: parentKey,
                  controllerAgentId: "main",
                  callerSessionKey: parentKey,
                  callerIsSubagent: false,
                  controlScope: "children",
                },
                runs: [subagentRuns.get(runId)!],
              }),
        )
        .finally(release);
      if (!replacement && publication !== "result") {
        expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", killed: 1 });
      }
      expect(holdingResult).toBe(true);
      expect(joinedPublication).toBe(true);
      expect(peerReleasedDuringPublication).toBe(competingIdle);
      expect(await producerOutcome).toEqual({ ok: true });
      const persisted = loadExactSessionEntryReadOnly({ storePath, sessionKey: childKey })?.entry;
      if (publication === "result") {
        expect(onResult).toHaveBeenCalledExactlyOnceWith(result);
        expect(result).toMatchObject({ found: true, killed: true });
        if (replacement) {
          expect(result).toHaveProperty("error", expect.stringContaining("ownership changed"));
          expect(result).not.toHaveProperty("targetState");
        } else {
          expect(result).not.toHaveProperty("error");
          expect(result).toMatchObject({
            targetState: { state: "terminal", task: { status: "cancelled" } },
          });
        }
        expect(persisted).toMatchObject({
          sessionId: replacement ? `${sessionId}-replacement` : sessionId,
          label: "metadata survived",
        });
        return;
      }
      if (replacement) {
        expect(result, JSON.stringify(result)).toMatchObject({ status: "error", killed: 0 });
        expect(persisted).toMatchObject({
          sessionId: `${sessionId}-replacement`,
          label: "metadata survived",
        });
        expect(persisted?.abortedLastRun).not.toBe(true);
        expect(subagentRuns.get(runId)?.endedReason).not.toBe("subagent-killed");
      } else {
        expect(persisted).toMatchObject({
          sessionId,
          label: "metadata survived",
          abortedLastRun: true,
        });
        expect(subagentRuns.get(runId)).toMatchObject({
          endedReason: "subagent-killed",
          execution: { status: "terminal" },
        });
      }
    } finally {
      release();
      await producerOutcome;
      await peerExecution?.release();
      signal.removeEventListener("abort", release);
      producerScope.disable();
      killScope.disable();
    }
  },
);

it("joins a pending session publication before a collector terminal commit", async ({ signal }) => {
  const parentKey = "agent:main:main";
  const childKey = "agent:main:subagent:pending-collector-publication";
  const runId = "pending-collector-publication";
  const sessionId = "pending-collector-publication-session";
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childKey,
    defaultSessionId: sessionId,
  });
  await registerSubagentRun({
    runId,
    childSessionKey: childKey,
    requesterSessionKey: parentKey,
    requesterAgentId: "main",
    requesterDisplayKey: parentKey,
    task: "held collector publication",
    collect: true,
    queued: false,
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
  enqueueSwarmRun({
    groupId: "pending-collector-publication",
    runId: "pending-collector-sibling",
    start: async () => {},
    activeRunIds: [runId],
    maxConcurrent: 1,
    onStartFailure: () => true,
  });
  const producerScope = new AsyncLocalStorage<boolean>();
  const completionScope = new AsyncLocalStorage<boolean>();
  const nativeHeld = createDeferredCore();
  const releaseNative = createDeferredCore();
  let producerPath: string | undefined;
  let holdingResult = false;
  let joinedPublication = false;
  let statusWhileJoined: string | undefined;
  let producerOutcome: Promise<unknown> | undefined;
  const release = () => releaseNative.resolve();
  signal.addEventListener("abort", release, { once: true });
  const runQueued = writerQueue.runQueuedStoreWrite;
  vi.spyOn(writerQueue, "runQueuedStoreWrite").mockImplementation((params) => {
    if (params.queues !== SQLITE_SESSION_WRITER_QUEUES) {
      return runQueued(params);
    }
    if (producerScope.getStore()) {
      producerPath ??= params.storePath;
    }
    const joining =
      completionScope.getStore() &&
      !producerScope.getStore() &&
      holdingResult &&
      params.storePath === producerPath;
    const before = joining
      ? new Set(params.queues.get(params.storePath)?.pending ?? [])
      : undefined;
    const result = runQueued(params);
    if (
      before &&
      params.queues.get(params.storePath)?.pending.some((entry) => !before.has(entry))
    ) {
      joinedPublication = true;
      release();
    }
    return result;
  });
  const captureExecution = executionOwner.captureOpenClawAgentDatabaseExecution;
  vi.spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution").mockImplementation(
    (...args) => {
      const execution = captureExecution(...args);
      if (!producerScope.getStore()) {
        return execution;
      }
      const runExisting: typeof execution.runExisting = (source, operation, options) =>
        execution.runExisting(
          source,
          (scope) =>
            operation({
              execute(command, commandOptions) {
                const pending = scope.execute(command, commandOptions);
                if (command.type !== "session.entries.replace" || holdingResult) {
                  return pending;
                }
                holdingResult = true;
                // The native commit granted publication custody; hold its settlement.
                return pending.then(async (value) => {
                  nativeHeld.resolve();
                  await releaseNative.promise;
                  // The waiting commit keeps its staged terminal row off-registry.
                  statusWhileJoined = subagentRuns.get(runId)?.execution.status;
                  return value;
                });
              },
            }),
          options,
        );
      return new Proxy(execution, {
        get(original, key, receiver) {
          return key === "runExisting" ? runExisting : Reflect.get(original, key, receiver);
        },
      });
    },
  );
  const prepareSession = controlSession.prepareSubagentKillSession;
  vi.spyOn(controlSession, "prepareSubagentKillSession").mockImplementation(async (...args) => {
    const session = await prepareSession(...args);
    if (!completionScope.getStore() || args[1] !== childKey || producerOutcome) {
      return session;
    }
    // Completion retained generation facts; a child metadata writer now reaches its
    // native commit before the terminal registry commit.
    const producer = runOutsideAsyncWorkScope(() =>
      runWithGatewayIndependentRootWorkAdmission(
        () =>
          producerScope.run(true, () =>
            applySessionEntryExactReplacements({
              agentId: "main",
              storePath,
              sessionKeys: [childKey],
              activeSessionKey: childKey,
              skipMaintenance: true,
              requireWriteSuccess: true,
              update(entries) {
                const row = entries.find((entry) => entry.sessionKey === childKey);
                if (!row || row.entry.sessionId !== sessionId) {
                  throw new Error("Metadata producer lost its child");
                }
                return {
                  result: undefined,
                  replacements: [
                    { sessionKey: childKey, entry: { ...row.entry, label: "metadata survived" } },
                  ],
                };
              },
            }),
          ),
        "test:collector-pending-metadata",
        signal,
      ),
    );
    producerOutcome = producer.then(
      () => ({ ok: true }),
      (error: unknown) => ({ error }),
    );
    await Promise.race([
      nativeHeld.promise,
      producer.then(() => {
        throw new Error("Metadata publication was not held");
      }),
    ]);
    return {
      ...session,
      // A failed commit still releases its session; never strand the held producer.
      release: async () => {
        release();
        await session.release();
      },
    };
  });
  const startedStatus = subagentRuns.get(runId)?.execution.status;
  try {
    completionScope.run(true, () =>
      emitAgentEvent({
        runId,
        sessionKey: childKey,
        sessionId,
        stream: "lifecycle",
        data: { phase: "end" },
      }),
    );
    await fixture.settle();
    expect(holdingResult).toBe(true);
    expect(joinedPublication).toBe(true);
    expect(startedStatus).not.toBe("terminal");
    expect(statusWhileJoined).toBe(startedStatus);
    expect(await producerOutcome).toEqual({ ok: true });
    expect(subagentRuns.get(runId)).toMatchObject({ execution: { status: "terminal" } });
    expect(isSwarmRunActive(runId)).toBe(false);
    expect(loadExactSessionEntryReadOnly({ storePath, sessionKey: childKey })?.entry).toMatchObject(
      { sessionId, label: "metadata survived" },
    );
  } finally {
    release();
    await producerOutcome;
    signal.removeEventListener("abort", release);
    producerScope.disable();
    completionScope.disable();
  }
});
