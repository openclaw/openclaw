import type { CopilotClient } from "@github/copilot-sdk";
import type { AgentHarnessAttemptResult as AgentHarnessAttemptResultContract } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  AgentHarnessTaskRecord,
  AgentHarnessTaskRuntime,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { vi } from "vitest";
import type { CopilotClientPool } from "./runtime.js";

type AgentHarnessAttemptResult = Extract<AgentHarnessAttemptResultContract, { terminal: unknown }>;

export function projectAgentRunAttemptTerminal(terminal: AgentHarnessAttemptResult["terminal"]) {
  return {
    aborted: terminal.kind === "aborted" && terminal.source !== "yield_cleanup",
    promptError:
      terminal.kind === "failed"
        ? terminal.error
        : terminal.kind === "ok"
          ? null
          : (terminal.failure?.error ?? null),
    timedOut: terminal.kind === "timeout" && terminal.source !== "observation",
    timedOutDuringCompaction: terminal.kind === "timeout" && terminal.phase === "compaction",
  };
}

export function makeFailingNativeTaskRuntime(failure: Error): AgentHarnessTaskRuntime {
  const task: AgentHarnessTaskRecord = {
    taskId: "native-task",
    runId: "copilot-agent:call-1",
    runtime: "subagent",
    taskKind: "copilot-native",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: "inspect",
    status: "running",
    notifyPolicy: "silent",
    deliveryStatus: "not_applicable",
    createdAt: 0,
  };
  return {
    assertTaskAssignmentSupported: () => undefined,
    createRunningTaskRun: () => task,
    tryCreateRunningTaskRun: () => task,
    recordTaskRunProgressByRunId: () => [],
    finalizeTaskRunByRunId: () => {
      throw failure;
    },
    setDetachedTaskDeliveryStatusByRunId: () => [],
    listTaskRecords: () => [task],
  };
}

export type SessionEventShape = {
  data: Record<string, unknown>;
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
};
type SendFn = (options?: unknown) => Promise<string>;
type SendAndWaitFn = (options?: unknown) => Promise<SessionEventShape | undefined>;

export type FakeSession = {
  abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
  cfg: Record<string, unknown>;
  disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  emit: (eventType: string, data: Record<string, unknown>) => void;
  id: string;
  off: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  rpc: {
    history: {
      cancelBackgroundCompaction: ReturnType<typeof vi.fn<() => Promise<{ cancelled: boolean }>>>;
    };
  };
  send: ReturnType<typeof vi.fn<SendFn>>;
  sendAndWait: ReturnType<typeof vi.fn<SendAndWaitFn>>;
  sessionId: string;
};

export type FakeSdk = ReturnType<typeof makeFakeSdk>;

function makeEvent(type: string, data: Record<string, unknown>): SessionEventShape {
  return {
    data,
    id: `${type}-id`,
    parentId: null,
    timestamp: "2024-01-01T00:00:00.000Z",
    type,
  };
}

export function makeAssistantMessageEvent(
  content = "assistant text",
  overrides: Partial<Record<string, unknown>> = {},
): SessionEventShape {
  return makeEvent("assistant.message", {
    content,
    messageId: "msg-1",
    model: "gpt-4o",
    ...overrides,
  });
}

function createFakeSession(cfg: Record<string, unknown>, id: string): FakeSession {
  const listeners = new Map<string, Array<(event: SessionEventShape) => void>>();
  return {
    abort: vi.fn<() => Promise<void>>(async () => undefined),
    cfg,
    disconnect: vi.fn<() => Promise<void>>(async () => undefined),
    emit: (eventType: string, data: Record<string, unknown>) => {
      const { __eventId, ...eventData } = data;
      const event = {
        ...makeEvent(eventType, eventData),
        ...(typeof __eventId === "string" ? { id: __eventId } : {}),
      };
      for (const listener of listeners.get(eventType) ?? []) {
        listener(event);
      }
    },
    id,
    off: vi.fn((eventType: string, handler: (event: SessionEventShape) => void) => {
      const handlers = listeners.get(eventType) ?? [];
      listeners.set(
        eventType,
        handlers.filter((existing) => existing !== handler),
      );
    }),
    on: vi.fn((eventType: string, handler: (event: SessionEventShape) => void) => {
      const handlers = listeners.get(eventType) ?? [];
      handlers.push(handler);
      listeners.set(eventType, handlers);
    }),
    rpc: {
      history: {
        cancelBackgroundCompaction: vi.fn<() => Promise<{ cancelled: boolean }>>(async () => ({
          cancelled: true,
        })),
      },
    },
    send: vi.fn<SendFn>(async () => "user-message-id"),
    sendAndWait: vi.fn<SendAndWaitFn>(async () => makeAssistantMessageEvent()),
    sessionId: id,
  };
}

export function makeFakePool(sdk: FakeSdk) {
  const pool = {
    acquire: vi.fn(async (key, _options) => ({
      client: sdk.client as unknown as CopilotClient,
      key,
    })),
    dispose: vi.fn(async () => []),
    release: vi.fn(async () => undefined),
    size: vi.fn(() => 0),
  } satisfies CopilotClientPool;
  return pool;
}

export function makeFakeSdk(
  options:
    | ((session: FakeSession, cfg: Record<string, unknown>) => void | Promise<void>)
    | {
        onCreateSession?: (
          session: FakeSession,
          cfg: Record<string, unknown>,
        ) => void | Promise<void>;
        onResumeSession?: (
          session: FakeSession,
          sessionId: string,
          cfg: Record<string, unknown>,
        ) => void | Promise<void>;
      } = {},
) {
  const sessions: FakeSession[] = [];
  const sessionHooks =
    typeof options === "function"
      ? { onCreateSession: options, onResumeSession: undefined }
      : options;

  const createSession = vi.fn(async (cfg: Record<string, unknown>) => {
    const session = createFakeSession(cfg, `sess-${sessions.length + 1}`);
    await sessionHooks.onCreateSession?.(session, cfg);
    sessions.push(session);
    return session;
  });

  const resumeSession = vi.fn(async (sessionId: string, cfg: Record<string, unknown>) => {
    const session = createFakeSession(cfg, sessionId);
    await sessionHooks.onResumeSession?.(session, sessionId, cfg);
    sessions.push(session);
    return session;
  });

  return {
    client: {
      createSession,
      deleteSession: vi.fn(async () => undefined),
      resumeSession,
      stop: vi.fn(async () => []),
    },
    createSession,
    resumeSession,
    sessions,
  };
}
