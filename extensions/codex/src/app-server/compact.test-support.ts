import { randomUUID } from "node:crypto";
import path from "node:path";
import { runWithAsyncWorkResources } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import { maybeCompactCodexAppServerSession as maybeCompactCodexAppServerSessionImpl } from "./compact.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { isJsonObject, type CodexServerNotification } from "./protocol.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { sessionBindingIdentity } from "./session-binding.js";
import {
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

let codexAppServerClientFactoryForTest: CodexAppServerClientFactory | undefined;
let compactionTestCleanup:
  | {
      controller: AbortController;
      pending: Set<Promise<unknown>>;
      released: Set<Promise<void>>;
      clients: Set<{ interrupt: () => void; close: () => void }>;
    }
  | undefined;

/** Opt in only where the suite owns these fake clients and every compaction it starts. */
export function beginCompactionTestCleanup() {
  if (compactionTestCleanup) {
    throw new Error("Previous compaction test cleanup has not finished");
  }
  const cleanup = {
    controller: new AbortController(),
    pending: new Set<Promise<unknown>>(),
    released: new Set<Promise<void>>(),
    clients: new Set<{ interrupt: () => void; close: () => void }>(),
  };
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
    }
    if (!failed && unfinished) {
      throw new Error("Test left compaction calls unsettled");
    }
  };
}

type MaybeCompactOptions = Omit<
  NonNullable<Parameters<typeof maybeCompactCodexAppServerSessionImpl>[1]>,
  "bindingStore"
> & {
  bindingStore?: NonNullable<
    Parameters<typeof maybeCompactCodexAppServerSessionImpl>[1]
  >["bindingStore"];
};

type CompactTestParams = Omit<
  Parameters<typeof maybeCompactCodexAppServerSessionImpl>[0],
  "hostCapabilities"
> &
  Partial<Pick<Parameters<typeof maybeCompactCodexAppServerSessionImpl>[0], "hostCapabilities">>;

/** Supplies only the admitted System host; explicit binding-store tests keep their own target. */
export function compactCodexSessionWithTestHost(
  params: CompactTestParams,
  options: Parameters<typeof maybeCompactCodexAppServerSessionImpl>[1],
) {
  const cleanup = compactionTestCleanup;
  if (!cleanup) {
    return runCompactionWithTestHost(params, options);
  }
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
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

function runCompactionWithTestHost(
  params: CompactTestParams,
  options: Parameters<typeof maybeCompactCodexAppServerSessionImpl>[1],
) {
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
  const identity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
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

export function createSandboxedCompactionParams(tempDir: string, sessionFile: string) {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    config: { agents: { defaults: { sandbox: { mode: "all" } } } },
  } satisfies Parameters<typeof maybeCompactCodexAppServerSession>[0];
}

export function createRemoteExecCompactionParams(tempDir: string, sessionFile: string) {
  const params: Parameters<typeof maybeCompactCodexAppServerSession>[0] & {
    sandbox: ReturnType<typeof createSandboxContext> & {
      placementExecutionMode: "remote-exec";
    };
  } = {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    sandbox: {
      ...createSandboxContext({}),
      placementExecutionMode: "remote-exec",
    },
  };
  return params;
}

export function createNodeExecCompactionParams(tempDir: string, sessionFile: string) {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
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

export function compactDetails(result: CompactResult): Record<string, unknown> {
  return (result.result?.details ?? {}) as Record<string, unknown>;
}

export async function flushAsyncTasks(iterations = 3): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
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
): {
  client: CodexAppServerClient;
  request: ReturnType<typeof vi.fn<CodexAppServerClient["request"]>>;
  close: ReturnType<typeof vi.fn>;
  closeAndWait: ReturnType<typeof vi.fn<CodexAppServerClient["closeAndWait"]>>;
  emit: (notification: CodexServerNotification) => void;
  completeCompaction: () => void;
} {
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
  const completeCompaction = (): void => {
    emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-1", threadId: "thread-1", status: "inProgress" },
      },
    });
    emit({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "compact-turn-1",
        item: { id: "compact-item-1", type: "contextCompaction" },
      },
    });
    emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "compact-turn-1",
        item: { id: "compact-item-1", type: "contextCompaction" },
      },
    });
    emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-1", status: "completed", items: [] },
      },
    });
  };
  const request = vi.fn<CodexAppServerClient["request"]>(
    async (method: string, params?: unknown) => {
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      if (method === "thread/resume" && threadId) {
        subscribedThreadIds.add(threadId);
        return {
          thread: {
            id: threadId,
            sessionId: "session-1",
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1,
            updatedAt: 1,
            status: { type: "idle" },
            path: null,
            cwd: tempDir,
            projectId: null,
            cliVersion: CODEX_APP_SERVER_VERSION,
            source: "unknown",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.5-codex",
          modelProvider: "openai",
          serviceTier: null,
          cwd: tempDir,
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "dangerFullAccess" },
          permissionProfile: null,
          reasoningEffort: null,
        };
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
        emit({
          method: "turn/started",
          params: {
            threadId,
            turn: { id: "compact-turn-1", threadId, status: "inProgress" },
          },
        });
        emit({
          method: "item/started",
          params: {
            threadId,
            turnId: "compact-turn-1",
            item: { id: "compact-item-1", type: "contextCompaction" },
          },
        });
        emit({
          method: "item/completed",
          params: {
            threadId,
            turnId: "compact-turn-1",
            item: { id: "compact-item-1", type: "contextCompaction" },
          },
        });
        emit({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: "compact-turn-1", status: "completed", items: [] },
          },
        });
      }
      return {};
    },
  );
  const close = vi.fn(() => {
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
          emit({
            method: "turn/started",
            params: { threadId, turn: { id: turnId, status: "inProgress" } },
          });
        }
        emit({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "interrupted", items: [] } },
        });
      }
    },
  });
  const addNotificationHandler = vi.fn(
    (handler: (notification: CodexServerNotification) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  );
  const client = {
    request,
    getTransportPid: () => undefined,
    close,
    closeAndWait,
    addNotificationHandler,
    addRequestHandler: vi.fn(() => () => undefined),
    addCloseHandler: vi.fn((handler: () => void) => {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    }),
  } as unknown as CodexAppServerClient;
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
    completeCompaction,
  };
}
