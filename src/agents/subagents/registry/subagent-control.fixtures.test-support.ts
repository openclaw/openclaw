import { AsyncLocalStorage } from "node:async_hooks";
import { expect, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import {
  beginSessionEffect,
  getSessionMutationCount,
  getSessionControllerWorkCount,
} from "../../../sessions/session-controller.lifecycle.js";
import { runOutsideAsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as writerQueue from "../../../shared/store-writer-queue.js";
import type { OpenClawAgentDatabaseExecution } from "../../../state/openclaw-agent-execution-contract.js";
import * as executionOwner from "../../../state/openclaw-agent-execution.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../../state/openclaw-agent-write-admission-state.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { enqueueSwarmRun } from "../swarm/swarm-scheduler.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

export const controlSessionKey = (id: string) => `agent:main:subagent:${id}`;
export const controlController = {
  controllerSessionKey: "agent:main:main",
  controllerAgentId: "main",
  callerSessionKey: "agent:main:main",
  callerIsSubagent: false,
  controlScope: "children" as const,
};
type RunOptions = Partial<Parameters<typeof registerSubagentRun>[0]>;
type SessionOptions = { sessionKey?: string; agentId?: string; defaultSessionId?: string };

export function createControlRunFixture(stateDir: () => string) {
  const targetFor = (id: string, options: SessionOptions = {}) => ({
    agentId: options.agentId ?? "main",
    sessionKey: options.sessionKey ?? controlSessionKey(id),
    defaultSessionId: options.defaultSessionId ?? `${id}-session`,
  });
  const writeSession = (id: string, lifecycleRevision?: string, options?: SessionOptions) =>
    writeSubagentSessionEntry({
      stateDir: stateDir(),
      ...targetFor(id, options),
      lifecycleRevision,
    });
  const register = (
    id: string,
    storePath: string | undefined,
    options: RunOptions = {},
    registrationOptions?: Parameters<typeof registerSubagentRun>[1],
  ) => {
    const sessionKey = options.childSessionKey ?? controlSessionKey(id);
    const agentId = options.childAgentId ?? "main";
    return registerSubagentRun(
      createSubagentRunParams({
        runId: id,
        task: id,
        childSessionKey: sessionKey,
        childAgentId: agentId,
        sessionEntry:
          "sessionEntry" in options
            ? options.sessionEntry
            : loadExactSessionEntryReadOnly({ agentId, storePath, sessionKey })?.entry,
        requesterAgentId: "main",
        expectsCompletionMessage: false,
        ...options,
      }),
      registrationOptions,
    );
  };
  const seed = async (
    id: string,
    options: RunOptions = {},
    lifecycleRevision = `${id}-session-revision`,
  ) => {
    const target = targetFor(id, {
      sessionKey: options.childSessionKey,
      agentId: options.childAgentId,
    });
    const storePath = await writeSession(id, lifecycleRevision, target);
    await register(id, storePath, options);
    return {
      ...target,
      storePath,
      sessionId: target.defaultSessionId,
      runId: options.runId ?? id,
      target: { stateDir: stateDir(), ...target, lifecycleRevision },
    };
  };
  return { writeSession, register, seed };
}

export function beginControlAdmission(
  scope: string,
  sessionKey: string,
  sessionId: string,
  onInterrupt?: Parameters<typeof beginSessionEffect>[0]["onInterrupt"],
  runId?: string,
) {
  return beginSessionEffect({
    agentId: "main",
    scope,
    identities: [sessionKey, sessionId],
    run: runId ? { runId, sessionKey, sessionId, agentId: "main" } : undefined,
    assertAllowed: () => {},
    onInterrupt,
  });
}

export function expectControlIdle() {
  expect(getSessionControllerWorkCount()).toBe(0);
  expect(getSessionMutationCount()).toBe(0);
}

type QueueOptions = Parameters<typeof enqueueSwarmRun>[0];
export function enqueueControlRun(
  groupId: string,
  runId: string,
  activeRunIds: QueueOptions["activeRunIds"],
  start: QueueOptions["start"],
  options: Partial<QueueOptions> = {},
) {
  enqueueSwarmRun({
    groupId,
    runId,
    activeRunIds,
    start,
    maxConcurrent: 1,
    onStartFailure: () => true,
    ...options,
  });
}

/** Hold a real native reply and observe consumers joining its physical writer FIFO. */
export function holdControlSessionPublication<Consumer>(options: {
  signal: AbortSignal;
  consumerScope: AsyncLocalStorage<Consumer>;
  onJoined?: (consumer: Consumer) => void;
  afterReleased?: () => void;
  reserveBeforeReply?: boolean;
}) {
  const producerScope = new AsyncLocalStorage<boolean>();
  const nativeHeld = createDeferredCore();
  const releaseNative = createDeferredCore();
  const state = { holdingResult: false, joinedPublication: false };
  let producerPath: string | undefined;
  const release = () => releaseNative.resolve();
  options.signal.addEventListener("abort", release, { once: true });
  const runQueued = writerQueue.runQueuedStoreWrite;
  vi.spyOn(writerQueue, "runQueuedStoreWrite").mockImplementation((params) => {
    if (params.queues !== SQLITE_SESSION_WRITER_QUEUES) {
      return runQueued(params);
    }
    if (producerScope.getStore()) {
      producerPath ??= params.storePath;
    }
    const consumer = options.consumerScope.getStore();
    const before =
      consumer &&
      !producerScope.getStore() &&
      state.holdingResult &&
      params.storePath === producerPath
        ? new Set(params.queues.get(params.storePath)?.pending ?? [])
        : undefined;
    const result = runQueued(params);
    if (
      before &&
      params.queues.get(params.storePath)?.pending.some((entry) => !before.has(entry))
    ) {
      state.joinedPublication = true;
      if (options.onJoined) {
        options.onJoined(consumer!);
      } else {
        release();
      }
    }
    return result;
  });
  const holdReply = async <T>(value: T) => {
    nativeHeld.resolve();
    await releaseNative.promise;
    options.afterReleased?.();
    return value;
  };
  const wrap = (execution: OpenClawAgentDatabaseExecution) => {
    if (!producerScope.getStore()) {
      return execution;
    }
    const original = execution.runExisting.bind(execution);
    const runExisting: typeof original = (source, operation, runOptions) =>
      original(
        source,
        (scope) =>
          operation({
            execute(command, commandOptions) {
              const pending = scope.execute(command, commandOptions);
              if (options.reserveBeforeReply === false) {
                return pending.then((value) => {
                  if (command.type !== "session.entries.replace" || state.holdingResult) {
                    return value;
                  }
                  state.holdingResult = true;
                  return holdReply(value);
                });
              }
              if (command.type !== "session.entries.replace" || state.holdingResult) {
                return pending;
              }
              state.holdingResult = true;
              return pending.then(holdReply);
            },
          }),
        runOptions,
      );
    return new Proxy(execution, {
      get(target, key, receiver) {
        return key === "runExisting" ? runExisting : Reflect.get(target, key, receiver);
      },
    });
  };
  const capture = executionOwner.captureOpenClawAgentDatabaseExecution;
  vi.spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution").mockImplementation((...args) =>
    wrap(capture(...args)),
  );
  const prepare = executionOwner.captureOpenClawAgentDatabasePreparationExecution;
  vi.spyOn(executionOwner, "captureOpenClawAgentDatabasePreparationExecution").mockImplementation(
    (...args) => wrap(prepare(...args)),
  );
  return {
    producerScope,
    nativeHeld,
    state,
    release,
    dispose: () => {
      options.signal.removeEventListener("abort", release);
      producerScope.disable();
      options.consumerScope.disable();
    },
  };
}

/** Publish through the real session writer, under the held native reply's scope. */
export function controlMetadataProducer(
  { producerScope, nativeHeld }: ReturnType<typeof holdControlSessionPublication>,
  {
    storePath,
    sessionKey,
    sessionId,
  }: { storePath: string; sessionKey: string; sessionId: string },
  signal: AbortSignal,
  options: { replacement?: boolean; label?: string } = {},
) {
  let producer: Promise<void> | undefined;
  let outcome: Promise<unknown> | undefined;
  const update = () =>
    applySessionEntryExactReplacements({
      agentId: "main",
      storePath,
      sessionKeys: [sessionKey],
      activeSessionKey: sessionKey,
      skipMaintenance: true,
      requireWriteSuccess: true,
      update(entries) {
        const row = entries.find((entry) => entry.sessionKey === sessionKey);
        if (!row || row.entry.sessionId !== sessionId) {
          throw new Error("Metadata producer lost its child");
        }
        const entry = {
          ...row.entry,
          sessionId: options.replacement ? `${sessionId}-replacement` : sessionId,
          label: options.label ?? "metadata survived",
        };
        return { result: undefined, replacements: [{ sessionKey, entry }] };
      },
    });
  return {
    get outcome() {
      return outcome;
    },
    async start() {
      if (producer) {
        return;
      }
      producer = runOutsideAsyncWorkScope(() =>
        runWithGatewayIndependentRootWorkAdmission(
          () => producerScope.run(true, update),
          "test:pending-metadata",
          signal,
        ),
      );
      outcome = producer.then(
        () => ({ ok: true }),
        (error: unknown) => ({ error }),
      );
      await awaitGateBeforeSettlement(
        nativeHeld.promise,
        producer,
        "Metadata publication not held",
      );
    },
  };
}
