import { EventEmitter } from "node:events";
import type { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import {
  agentHarnessAttemptTerminal,
  type AgentHarnessAttemptParamsV2,
  type AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { runInHarnessToolAuthorityForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import { runCopilotAttempt as runCopilotAttemptImpl } from "./attempt.js";
import type { CopilotClientPool } from "./runtime.js";

export function createAttemptGate<T = void>() {
  const entered = createDeferred<void>();
  const released = createDeferred<T>();
  const wait = () => {
    entered.resolve();
    return released.promise;
  };
  return { entered: entered.promise, release: released.resolve, wait };
}

export async function awaitAttemptStage(stage: Promise<unknown>, attempt: Promise<unknown>) {
  const settled = attempt.then((result) => {
    throw new Error("Copilot attempt settled before the expected stage", { cause: result });
  });
  await Promise.race([stage, settled]);
}

export const projectAgentRunAttemptTerminal = agentHarnessAttemptTerminal.project;

export function makeUserTurnRecorder(message: Extract<AgentMessage, { role: "user" }>) {
  let blocked = false;
  let persisted = false;
  return {
    message,
    resolveMessage: vi.fn(async () => message),
    markRuntimePersistencePending: vi.fn(),
    markRuntimePersisted: vi.fn(() => {
      persisted = true;
    }),
    markBlocked: vi.fn(() => {
      blocked = true;
    }),
    hasPersisted: () => persisted,
    isBlocked: () => blocked,
    hasRuntimePersistencePending: () => false,
    getAdmissionReceipt: () => undefined,
    waitForRuntimePersistence: vi.fn(async () => undefined),
    persistApproved: vi.fn(async () => undefined),
    persistBlocked: vi.fn(async () => undefined),
    persistFallback: vi.fn(async () => undefined),
  } satisfies NonNullable<AgentHarnessAttemptParamsV2["userTurnTranscriptRecorder"]>;
}

export function makeCopilotModel(
  overrides: Partial<AgentHarnessAttemptParamsV2["model"]> = {},
): AgentHarnessAttemptParamsV2["model"] {
  return {
    api: "openai-responses",
    id: "gpt-5",
    name: "GPT-5",
    provider: "github-copilot",
    baseUrl: "https://api.githubcopilot.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    ...overrides,
  };
}

export function runCopilotAttempt(...[params, deps]: Parameters<typeof runCopilotAttemptImpl>) {
  return runInHarnessToolAuthorityForTest(params, "copilot", (admitted) =>
    runCopilotAttemptImpl(admitted, deps),
  );
}

export type SessionEventShape = Pick<SessionEvent, "id" | "parentId" | "timestamp"> & {
  data: Record<string, unknown>;
  type: string;
};
type SendFn = (options?: unknown) => Promise<string>;
type SendAndWaitFn = (options?: unknown) => Promise<SessionEventShape | undefined>;

export type FakeSession = ReturnType<typeof createFakeSession>;
export type FakeSdk = ReturnType<typeof makeFakeSdk>;
type SdkConfig = Record<string, unknown>;
type SessionHook = (session: FakeSession, cfg: SdkConfig) => void | Promise<void>;
type ResumeHook = (session: FakeSession, id: string, cfg: SdkConfig) => ReturnType<SessionHook>;
type SessionHooks = { onCreateSession?: SessionHook; onResumeSession?: ResumeHook };
const EVENT_META = { parentId: null, timestamp: "2024-01-01T00:00:00.000Z" };
const ASSISTANT_META = { messageId: "msg-1", model: "gpt-4o" };

function makeEvent(type: string, data: Record<string, unknown>): SessionEventShape {
  return { data, id: `${type}-id`, ...EVENT_META, type };
}

export function makeAssistantMessageEvent(
  content = "assistant text",
  overrides: Partial<Record<string, unknown>> = {},
): SessionEventShape {
  return makeEvent("assistant.message", { content, ...ASSISTANT_META, ...overrides });
}

function createFakeSession(id: string) {
  const events = new EventEmitter();
  const off = vi.fn((eventType: string, handler: (event: SessionEventShape) => void) => {
    while (events.listeners(eventType).includes(handler)) {
      events.off(eventType, handler);
    }
  });
  return {
    abort: vi.fn<() => Promise<void>>(async () => undefined),
    disconnect: vi.fn<() => Promise<void>>(async () => undefined),
    emit: (eventType: string, data: Record<string, unknown>) => {
      const { __eventId, ...eventData } = data;
      const event = {
        ...makeEvent(eventType, eventData),
        ...(typeof __eventId === "string" ? { id: __eventId } : {}),
      };
      events.emit(eventType, event);
    },
    id,
    off,
    on: vi.fn((eventType: string, handler: (event: SessionEventShape) => void) => {
      events.on(eventType, handler);
      return () => off(eventType, handler);
    }),
    rpc: {
      history: {
        cancelBackgroundCompaction: vi.fn(async () => ({ cancelled: true })),
      },
    },
    send: vi.fn<SendFn>(async () => "user-message-id"),
    sendAndWait: vi.fn<SendAndWaitFn>(async () => makeAssistantMessageEvent()),
    sessionId: id,
  };
}

export function makeFakePool(sdk: FakeSdk) {
  return {
    acquire: vi.fn(async (key, _options) => ({
      client: sdk.client as unknown as CopilotClient,
      key,
    })),
    dispose: vi.fn(async () => []),
    release: vi.fn(async () => undefined),
    size: vi.fn(() => 0),
  } satisfies CopilotClientPool;
}

export function makeFakeSdk(options: SessionHook | SessionHooks = {}) {
  const sessions: FakeSession[] = [];
  const sessionHooks =
    typeof options === "function"
      ? { onCreateSession: options, onResumeSession: undefined }
      : options;

  const createSession = vi.fn(async (cfg: SdkConfig) => {
    const session = createFakeSession(`sess-${sessions.length + 1}`);
    await sessionHooks.onCreateSession?.(session, cfg);
    sessions.push(session);
    return session;
  });

  const resumeSession = vi.fn(async (sessionId: string, cfg: SdkConfig) => {
    const session = createFakeSession(sessionId);
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
