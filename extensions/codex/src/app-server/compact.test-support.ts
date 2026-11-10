import { randomUUID } from "node:crypto";
import path from "node:path";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { runWithAsyncWorkResources } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { maybeCompactCodexAppServerSession as maybeCompactCodexAppServerSessionImpl } from "./compact.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { isJsonObject, type CodexServerNotification, type JsonObject } from "./protocol.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { sessionBindingIdentity } from "./session-binding.js";
import {
  registerCodexTestSessionIdentity,
  createCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

let codexAppServerClientFactoryForTest: CodexAppServerClientFactory | undefined;
let compactionTestCleanup: ReturnType<typeof createCompactionCleanup> | undefined;

function createCompactionCleanup() {
  return {
    controller: new AbortController(),
    pending: new Set<Promise<unknown>>(),
    released: new Set<Promise<void>>(),
    clients: new Set<{ interrupt: () => void; close: () => void }>(),
  };
}

/** Opt in only where the suite owns these fake clients and every compaction it starts. */
export function beginCompactionTestCleanup() {
  if (compactionTestCleanup) {
    throw new Error("Previous compaction test cleanup has not finished");
  }
  setRuntimeConfigSnapshot({});
  const cleanup = createCompactionCleanup();
  compactionTestCleanup = cleanup;
  return async (failed: boolean) => {
    const unfinished = cleanup.pending.size > 0;
    try {
      // A returned result may still own normal async release; only failed or unfinished calls
      // need cancellation and fake terminal events before their retained cleanup can drain.
      if (failed || unfinished) {
        cleanup.controller.abort(new Error("Compaction test ended before its owned work settled"));
        for (const client of cleanup.clients) {
          client.interrupt();
        }
      }
      await Promise.allSettled(cleanup.pending);
      await Promise.all(cleanup.released);
    } finally {
      for (const client of cleanup.clients) {
        client.close();
      }
      compactionTestCleanup = undefined;
      clearRuntimeConfigSnapshot();
    }
    if (!failed && unfinished) {
      throw new Error("Test left compaction calls unsettled");
    }
  };
}

type CompactParams = Parameters<typeof maybeCompactCodexAppServerSessionImpl>[0];
type CompactOptions = NonNullable<Parameters<typeof maybeCompactCodexAppServerSessionImpl>[1]>;
type MaybeCompactOptions = Omit<CompactOptions, "bindingStore"> &
  Partial<Pick<CompactOptions, "bindingStore">>;
type CompactTestParams = Omit<CompactParams, "hostCapabilities"> &
  Partial<Pick<CompactParams, "hostCapabilities">>;

/** Supplies only the admitted System host; explicit binding-store tests keep their own target. */
export function compactCodexSessionWithTestHost(
  params: CompactTestParams,
  options: CompactOptions,
) {
  setRuntimeConfigSnapshot(params.config ?? {});
  const cleanup = compactionTestCleanup;
  if (!cleanup) {
    return runCompactionWithTestHost(params, options);
  }
  const { promise: released, resolve: release } = createDeferred<void>();
  cleanup.released.add(released);
  void released.then(() => {
    cleanup.released.delete(released);
  });
  const pending = runWithAsyncWorkResources(async (onAcquired) => {
    // This release follows retained queue cleanup, even if the logical result canceled first.
    onAcquired({ release });
    return await runCompactionWithTestHost(
      {
        ...params,
        abortSignal: params.abortSignal
          ? AbortSignal.any([params.abortSignal, cleanup.controller.signal])
          : cleanup.controller.signal,
      },
      options,
    );
  });
  cleanup.pending.add(pending);
  void pending.then(
    () => cleanup.pending.delete(pending),
    () => cleanup.pending.delete(pending),
  );
  return pending;
}

function runCompactionWithTestHost(params: CompactTestParams, options: CompactOptions) {
  if (params.hostCapabilities) {
    return maybeCompactCodexAppServerSessionImpl(
      { ...params, hostCapabilities: params.hostCapabilities },
      options,
    );
  }
  return runWithAsyncWorkResources(async (onAcquired) => {
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: {
        runId: params.runId ?? randomUUID(),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionTarget: params.sessionTarget,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: params.config,
        abortSignal: params.abortSignal,
      },
      pluginId: "codex",
      nativeModelPolicySupport: "exact",
    });
    onAcquired({ release: host.close, releaseBeforeResultWhenIdle: true });
    const capabilities = host.capabilities;
    if (!capabilities.retainSourceAuthority) {
      throw new Error("Compaction fixture requires the production source capability");
    }
    return await maybeCompactCodexAppServerSessionImpl(
      {
        ...params,
        hostCapabilities: {
          kind: capabilities.kind,
          version: capabilities.version,
          assertActive: capabilities.assertActive,
          retainSourceAuthority: capabilities.retainSourceAuthority,
        },
      },
      options,
    );
  });
}

export function setCodexAppServerClientFactoryForTest(factory: CodexAppServerClientFactory): void {
  codexAppServerClientFactoryForTest = factory;
}

export function resetCodexAppServerClientFactoryForTest(): void {
  codexAppServerClientFactoryForTest = undefined;
}

export function maybeCompactCodexAppServerSession(
  params: CompactTestParams,
  options: MaybeCompactOptions = {},
) {
  const identity = sessionBindingIdentity(params);
  registerCodexTestSessionIdentity(
    params.sessionFile,
    params.sessionId,
    params.sessionKey,
    identity.agentId,
  );
  const clientFactory = options.clientFactory ?? codexAppServerClientFactoryForTest;
  return compactCodexSessionWithTestHost(params, {
    ...options,
    bindingStore: options.bindingStore ?? testCodexAppServerBindingStore,
    ...(clientFactory ? { clientFactory } : {}),
  });
}

export async function writeCompactionTestBinding(
  tempDir: string,
  options: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
  sessionKey = "agent:main:session-1",
): Promise<string> {
  const sessionFile = path.join(tempDir, "session.jsonl");
  const identity = sessionBindingIdentity({ sessionId: "session-1", sessionKey });
  registerCodexTestSessionIdentity(sessionFile, "session-1", sessionKey, identity.agentId);
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-1",
    cwd: tempDir,
    ...options,
  });
  return sessionFile;
}

export async function writeSupervisedTestBinding(
  tempDir: string,
  options: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
): Promise<string> {
  return writeCompactionTestBinding(tempDir, {
    connectionScope: "supervision",
    supervisionSourceThreadId: "source-thread-1",
    preserveNativeModel: true,
    conversationSourceTransferComplete: true,
    model: "gpt-5.4",
    modelProvider: "openai",
    appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
      resolveCodexSupervisionAppServerRuntimeOptions({
        pluginConfig: { supervision: { enabled: true } },
      }),
    ),
    ...options,
  });
}

export function compactionParams(
  tempDir: string,
  sessionFile: string,
  overrides: Partial<CompactTestParams> = {},
): CompactTestParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    ...overrides,
  };
}

export async function recoveredCompactionBinding(
  tempDir: string,
  sessionKey: string,
  options: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
) {
  const current = {
    kind: "session" as const,
    agentId: "main",
    sessionKey,
    sessionId: "after-compaction",
  };
  const previous = { ...current, sessionId: "before-compaction" };
  const scope = {
    agentId: "main",
    sessionKey,
    storePath: path.join(tempDir, "admitted", "sessions.json"),
  };
  await upsertSessionEntry({ ...scope, entry: { sessionId: previous.sessionId, updatedAt: 1 } });
  await patchSessionEntry({ ...scope, update: () => ({ sessionId: current.sessionId }) });
  const bindingStore = createCodexTestBindingStore();
  const binding = { threadId: "thread-1", cwd: tempDir, ...options };
  await bindingStore.mutate(previous, { kind: "set", binding });
  return { current, scope, bindingStore, binding };
}

export function compactionItemEvent(
  method: "item/started" | "item/completed",
  turnId: string,
  itemId = "compact-item-1",
  threadId = "thread-1",
): CodexServerNotification {
  return { method, params: { threadId, turnId, item: { id: itemId, type: "contextCompaction" } } };
}

export function createSandboxedCompactionParams(tempDir: string, sessionFile: string) {
  return {
    ...compactionParams(tempDir, sessionFile),
    config: { agents: { defaults: { sandbox: { mode: "all" } } } },
  } satisfies Parameters<typeof maybeCompactCodexAppServerSession>[0];
}

export function createRemoteExecCompactionParams(tempDir: string, sessionFile: string) {
  return {
    ...compactionParams(tempDir, sessionFile),
    sandbox: {
      ...createSandboxContext({}),
      placementExecutionMode: "remote-exec",
    },
  } satisfies CompactTestParams & {
    sandbox: ReturnType<typeof createSandboxContext> & { placementExecutionMode: "remote-exec" };
  };
}

export function createNodeExecCompactionParams(tempDir: string, sessionFile: string) {
  return {
    ...compactionParams(tempDir, sessionFile),
    config: { tools: { exec: { host: "node", node: "worker-1" } } },
  } satisfies Parameters<typeof maybeCompactCodexAppServerSession>[0];
}

type CompactResult = NonNullable<Awaited<ReturnType<typeof maybeCompactCodexAppServerSession>>>;

export function requireCompactResult(result: CompactResult | undefined): CompactResult {
  if (!result) {
    throw new Error("expected compaction result");
  }
  return result;
}

export async function flushAsyncTasks(iterations = 3): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await nextImmediate();
  }
}

export async function expectExternalMutationBlockedDuringNativeRequest(params: {
  releaseExternalMutation: () => void;
  isExternalMutationStarted: () => boolean;
  isExternalMutationFinished: () => boolean;
}): Promise<Record<string, never>> {
  params.releaseExternalMutation();
  await flushAsyncTasks();
  expect(params.isExternalMutationStarted()).toBe(true);
  expect(params.isExternalMutationFinished()).toBe(false);
  return {};
}

export function createFakeCodexCompactionClient(
  tempDir: string,
  options: {
    autoCompleteCompaction?: boolean;
    interruptError?: Error;
    rejectInterrupt?: boolean;
    retainedThreadId?: string | null;
    subscribedThreadIds?: readonly string[];
  } = {},
) {
  const handlers = new Set<(notification: CodexServerNotification) => void>();
  const closeHandlers = new Set<() => void>();
  const retainedThreadId =
    options.retainedThreadId === undefined ? "thread-1" : options.retainedThreadId;
  const subscribedThreadIds = new Set(
    options.subscribedThreadIds ?? (retainedThreadId ? [retainedThreadId] : []),
  );
  const observedTurns = new Map<
    string,
    { requestIndex: number; turnId: string; completed: boolean }
  >();
  const emit = (notification: CodexServerNotification): void => {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    if (threadId && !subscribedThreadIds.has(threadId)) {
      return;
    }
    const turnId =
      typeof params?.turnId === "string"
        ? params.turnId
        : isJsonObject(params?.turn) && typeof params.turn.id === "string"
          ? params.turn.id
          : undefined;
    if (
      threadId &&
      turnId &&
      (notification.method === "turn/started" ||
        notification.method === "item/started" ||
        notification.method === "turn/completed")
    ) {
      const requestIndex = request.mock.calls.findLastIndex(
        ([method, args]) =>
          method === "thread/compact/start" && isJsonObject(args) && args.threadId === threadId,
      );
      const previous = observedTurns.get(threadId);
      if (
        requestIndex >= 0 &&
        (!previous ||
          previous.requestIndex !== requestIndex ||
          notification.method === "turn/started" ||
          previous.turnId === turnId)
      ) {
        observedTurns.set(threadId, {
          requestIndex,
          turnId,
          completed: notification.method === "turn/completed",
        });
      }
    }
    for (const handler of handlers) {
      handler(notification);
    }
  };
  const emitTurn = (threadId: string, turn: JsonObject): void => {
    emit({
      method: turn.status === "inProgress" ? "turn/started" : "turn/completed",
      params: { threadId, turn },
    });
  };
  const completeCompaction = (threadId = "thread-1"): void => {
    emitTurn(threadId, { id: "compact-turn-1", threadId, status: "inProgress" });
    for (const method of ["item/started", "item/completed"] as const) {
      emit(compactionItemEvent(method, "compact-turn-1", "compact-item-1", threadId));
    }
    emitTurn(threadId, { id: "compact-turn-1", status: "completed", items: [] });
  };
  const request = vi.fn<CodexAppServerClient["request"]>(
    async (method: string, params?: unknown) => {
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      if (method === "thread/resume" && threadId) {
        subscribedThreadIds.add(threadId);
        return { ...threadStartResult(threadId, tempDir), model: "gpt-5.5-codex" };
      }
      if (method === "thread/unsubscribe" && threadId) {
        subscribedThreadIds.delete(threadId);
        return {};
      }
      if (method === "turn/interrupt" && options.interruptError) {
        throw options.interruptError;
      }
      if (method === "turn/interrupt" && options.rejectInterrupt) {
        throw new Error("interrupt unavailable");
      }
      if (method === "thread/compact/start" && options.autoCompleteCompaction !== false) {
        if (typeof threadId !== "string") {
          throw new Error("thread/compact/start requires threadId");
        }
        // Codex may emit item notifications before acknowledging the start RPC.
        completeCompaction(threadId);
      }
      return {};
    },
  );
  const { client } = createClientHarness();
  const closeTransport = client.close.bind(client);
  const close = vi.fn(() => {
    closeTransport();
    for (const handler of closeHandlers) {
      handler();
    }
  });
  const closeAndWait = vi.fn<CodexAppServerClient["closeAndWait"]>(async () => {
    close();
    return { exited: true, cleanup: "closed" };
  });
  compactionTestCleanup?.clients.add({
    close,
    interrupt: () => {
      const starts = new Map<string, number>();
      request.mock.calls.forEach(([method, params], index) => {
        if (
          method === "thread/compact/start" &&
          isJsonObject(params) &&
          typeof params.threadId === "string"
        ) {
          starts.set(params.threadId, index);
        }
      });
      for (const [threadId, requestIndex] of starts) {
        const observed = observedTurns.get(threadId);
        if (observed?.requestIndex === requestIndex && observed.completed) {
          continue;
        }
        const turnId =
          observed?.requestIndex === requestIndex ? observed.turnId : "test-cleanup-turn";
        if (observed?.requestIndex !== requestIndex) {
          emitTurn(threadId, { id: turnId, status: "inProgress" });
        }
        emitTurn(threadId, { id: turnId, status: "interrupted", items: [] });
      }
    },
  });
  const addNotificationHandler = vi.fn(
    (handler: (notification: CodexServerNotification) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  );
  Object.assign(client, {
    request,
    getInstanceId: vi.fn(() => "fake-compaction-client"),
    getTransportPid: () => undefined,
    close,
    closeAndWait,
    addNotificationHandler,
    addRequestHandler: vi.fn(() => () => undefined),
    addCloseHandler: vi.fn((handler: () => void) => {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    }),
  });
  ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
  addNotificationHandler.mockClear();
  if (retainedThreadId) {
    void retainCodexAppServerLiveThread(
      client,
      retainedThreadId,
      undefined,
      `config-${retainedThreadId}`,
    );
  }
  return {
    client,
    request,
    close,
    closeAndWait,
    emit,
    completeCompaction: () => completeCompaction(),
  };
}

export const compactUnboundedRequestOptions = {
  assertCurrent: expect.any(Function),
  withCurrent: expect.any(Function),
  signal: expect.any(AbortSignal),
};
export const compactStartRequestOptions = { timeoutMs: 60_000, ...compactUnboundedRequestOptions };

export function expectCompactStartRequest(
  request: ReturnType<typeof createFakeCodexCompactionClient>["request"],
  threadId: string,
  options: typeof compactStartRequestOptions | typeof compactUnboundedRequestOptions,
): void {
  expect(request).toHaveBeenCalledWith("thread/compact/start", { threadId }, options);
}
