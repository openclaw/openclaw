import type { CopilotClient } from "@github/copilot-sdk";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCopilotSdkAttempt } from "./attempt.js";
import type { CopilotClientPool } from "./runtime.js";

type SessionEventShape = {
  data: Record<string, unknown>;
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
};

type FakeSession = {
  abort: ReturnType<typeof vi.fn>;
  cfg: Record<string, unknown>;
  disconnect: ReturnType<typeof vi.fn>;
  emit: (eventType: string, data: Record<string, unknown>) => void;
  id: string;
  off: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  sendAndWait: ReturnType<typeof vi.fn>;
  sessionId: string;
};

type FakeSdk = ReturnType<typeof makeFakeSdk>;

function createDeferred<T>() {
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject(reason?: unknown) {
      rejectPromise?.(reason);
    },
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
}

function flushAsync() {
  return Promise.resolve().then(() => Promise.resolve());
}

function getPromptErrorCode(result: AgentHarnessAttemptResult): string | undefined {
  return (result.promptError as { code?: string } | undefined)?.code;
}

function getSdkSessionId(result: AgentHarnessAttemptResult): string | undefined {
  return (result as AgentHarnessAttemptResult & { sdkSessionId?: string }).sdkSessionId;
}

function makeEvent(type: string, data: Record<string, unknown>): SessionEventShape {
  return {
    data,
    id: `${type}-id`,
    parentId: null,
    timestamp: "2024-01-01T00:00:00.000Z",
    type,
  };
}

function makeAssistantMessageEvent(
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
    abort: vi.fn(async () => undefined),
    cfg,
    disconnect: vi.fn(async () => undefined),
    emit: (eventType: string, data: Record<string, unknown>) => {
      const event = makeEvent(eventType, data);
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
    sendAndWait: vi.fn(async () => makeAssistantMessageEvent()),
    sessionId: id,
  };
}

function makeFakePool(sdk: FakeSdk) {
  const pool: CopilotClientPool = {
    acquire: vi.fn(async (key, _options) => ({
      client: sdk.client as unknown as CopilotClient,
      key,
    })),
    dispose: vi.fn(async () => []),
    release: vi.fn(async () => undefined),
    size: vi.fn(() => 0),
  };
  return pool;
}

function makeFakeSdk(
  options: {
    onCreateSession?: (session: FakeSession, cfg: Record<string, unknown>) => void | Promise<void>;
    onResumeSession?: (
      session: FakeSession,
      sessionId: string,
      cfg: Record<string, unknown>,
    ) => void | Promise<void>;
  } = {},
) {
  const sessions: FakeSession[] = [];

  const createSession = vi.fn(async (cfg: Record<string, unknown>) => {
    const session = createFakeSession(cfg, `sess-${sessions.length + 1}`);
    await options.onCreateSession?.(session, cfg);
    sessions.push(session);
    return session;
  });

  const resumeSession = vi.fn(async (sessionId: string, cfg: Record<string, unknown>) => {
    const session = createFakeSession(cfg, sessionId);
    await options.onResumeSession?.(session, sessionId, cfg);
    sessions.push(session);
    return session;
  });

  return {
    client: {
      createSession,
      resumeSession,
      stop: vi.fn(async () => []),
    },
    createSession,
    resumeSession,
    sessions,
  };
}

function makeParams(
  overrides: Partial<
    AgentHarnessAttemptParams & {
      auth: {
        gitHubToken?: string;
        profileId?: string;
        profileVersion?: string;
        useLoggedInUser?: boolean;
      };
      initialReplayState: { sdkSessionId?: string };
      messages: Array<{ content: string; role: "user"; timestamp: number }>;
      model: { api: string; id: string; provider: string };
      onAssistantDelta: (payload: { delta: string; text: string }) => void | Promise<void>;
      profileVersion: string;
    }
  > = {},
): AgentHarnessAttemptParams {
  return {
    agentDir: "C:\\copilot-home",
    agentId: "agent-1",
    auth: { useLoggedInUser: true, ...(overrides as { auth?: object }).auth },
    initialReplayState: undefined,
    messages: [{ content: "hello", role: "user", timestamp: 1 }],
    model: {
      api: "openai-responses",
      id: "gpt-4o",
      provider: "github",
      ...(typeof overrides.model === "object" ? overrides.model : {}),
    },
    prompt: "hello",
    runId: "run-1",
    sessionFile: "session.json",
    sessionId: "session-1",
    timeoutMs: 5000,
    workspaceDir: "C:\\workspace",
    ...overrides,
  } as unknown as AgentHarnessAttemptParams;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCopilotSdkAttempt", () => {
  it("happy path", async () => {
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(makeParams(), { pool });

    expect(sdk.createSession).toHaveBeenCalledTimes(1);
    expect(sdk.sessions[0]?.sendAndWait).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeUndefined();
    expect(result.lastAssistant?.role).toBe("assistant");
    expect(result.assistantTexts).toEqual(["done"]);
    expect(result.messagesSnapshot.length).toBe(2);
    expect(getSdkSessionId(result)).toBe("sess-1");
  });

  it("subscribe-before-send", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams(), { pool });

    const session = sdk.sessions[0];
    expect(session.on.mock.calls[0]?.[0]).toBe("assistant.message_delta");
    expect(session.on.mock.invocationCallOrder[0]).toBeLessThan(
      session.sendAndWait.mock.invocationCallOrder[0],
    );
  });

  it("deltas forwarded in order via promise chain", async () => {
    const sendDeferred = createDeferred<SessionEventShape | undefined>();
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const onAssistantDelta = vi.fn(async (payload: { delta: string }) => {
      order.push(`start:${payload.delta}`);
      await new Promise<void>((resolve) => {
        releases.push(() => {
          order.push(`end:${payload.delta}`);
          resolve();
        });
      });
    });
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockReturnValue(sendDeferred.promise);
      },
    });
    const pool = makeFakePool(sdk);

    const runPromise = runCopilotSdkAttempt(makeParams({ onAssistantDelta }), { pool });
    await flushAsync();

    const session = sdk.sessions[0];
    session.emit("assistant.message_delta", { deltaContent: "a", messageId: "msg-1" });
    session.emit("assistant.message_delta", { deltaContent: "b", messageId: "msg-1" });
    session.emit("assistant.message_delta", { deltaContent: "c", messageId: "msg-1" });
    await flushAsync();

    expect(onAssistantDelta).toHaveBeenCalledTimes(1);
    releases[0]?.();
    await flushAsync();
    expect(onAssistantDelta).toHaveBeenCalledTimes(2);
    releases[1]?.();
    await flushAsync();
    expect(onAssistantDelta).toHaveBeenCalledTimes(3);
    releases[2]?.();
    sendDeferred.resolve(makeAssistantMessageEvent("abc"));

    const result = await runPromise;
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    expect(result.assistantTexts).toEqual(["abc"]);
  });

  it("deltas forwarded even when no consumer", async () => {
    const sendDeferred = createDeferred<SessionEventShape | undefined>();
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockReturnValue(sendDeferred.promise);
      },
    });
    const pool = makeFakePool(sdk);

    const runPromise = runCopilotSdkAttempt(makeParams(), { pool });
    await flushAsync();

    const session = sdk.sessions[0];
    session.emit("assistant.message_delta", { deltaContent: "a", messageId: "msg-1" });
    session.emit("assistant.message_delta", { deltaContent: "b", messageId: "msg-1" });
    session.emit("assistant.message_delta", { deltaContent: "c", messageId: "msg-1" });
    sendDeferred.resolve(makeAssistantMessageEvent("abc"));

    const result = await runPromise;
    expect(result.assistantTexts).toEqual(["abc"]);
  });

  it("resume path", async () => {
    const sdk = makeFakeSdk({
      onResumeSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("resumed"));
      },
    });
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(
      makeParams({ initialReplayState: { sdkSessionId: "resume-1" } as never }),
      { pool },
    );

    expect(sdk.resumeSession).toHaveBeenCalledTimes(1);
    expect(sdk.resumeSession.mock.calls[0]?.[0]).toBe("resume-1");
    expect(
      (sdk.resumeSession.mock.calls[0]?.[1] as { continuePendingWork?: boolean })
        .continuePendingWork,
    ).toBe(false);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
  });

  it("abort path (mid-stream)", async () => {
    const controller = new AbortController();
    const sendDeferred = createDeferred<SessionEventShape | undefined>();
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockReturnValue(sendDeferred.promise);
        session.abort.mockImplementationOnce(async () => {
          sendDeferred.resolve(undefined);
        });
      },
    });
    const pool = makeFakePool(sdk);

    const runPromise = runCopilotSdkAttempt(makeParams({ abortSignal: controller.signal }), {
      pool,
    });
    await flushAsync();

    controller.abort();
    const result = await runPromise;

    expect(sdk.sessions[0]?.abort).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    expect(result.externalAbort).toBe(true);
  });

  it("abort path (signal already aborted)", async () => {
    const controller = new AbortController();
    controller.abort();
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(makeParams({ abortSignal: controller.signal }), {
      pool,
    });

    expect(result.aborted).toBe(true);
    expect(result.externalAbort).toBe(true);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(pool.acquire).toHaveBeenCalledTimes(0);
  });

  it("abort path (signal fires after settled)", async () => {
    const controller = new AbortController();
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(makeParams({ abortSignal: controller.signal }), {
      pool,
    });
    controller.abort();

    expect(sdk.sessions[0]?.abort).toHaveBeenCalledTimes(0);
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("placeholder tools", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams(), { pool });

    expect((sdk.createSession.mock.calls[0]?.[0] as { tools?: unknown[] }).tools).toEqual([]);
  });

  it("placeholder permission handler denies", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams(), { pool });

    const handler = (
      sdk.createSession.mock.calls[0]?.[0] as {
        onPermissionRequest: (request: {
          kind: string;
        }) => Promise<{ kind: string; reason?: string }>;
      }
    ).onPermissionRequest;
    const result = await handler({ kind: "write" });
    expect(result.kind).toBe("deny");
    expect(result.reason).toContain("permission-bridge");
  });

  it("placeholder user-input handler throws", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams(), { pool });

    const handler = (
      sdk.createSession.mock.calls[0]?.[0] as {
        onUserInputRequest: (request: { question: string }) => Promise<unknown>;
      }
    ).onUserInputRequest;
    await expect(handler({ question: "name?" })).rejects.toThrow("user-input-bridge");
  });

  it("timeout", async () => {
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(undefined);
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(makeParams(), { pool });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(getSdkSessionId(result)).toBe("sess-1");
    expect(sdk.sessions[0]?.abort).toHaveBeenCalledTimes(0);
  });

  it("model translation: unsupported provider", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(
      makeParams({
        model: { api: "openai-responses", id: "claude", provider: "anthropic" } as never,
      }),
      { pool },
    );

    expect(getPromptErrorCode(result)).toBe("model_not_supported");
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(pool.acquire).toHaveBeenCalledTimes(0);
    expect(pool.release).toHaveBeenCalledTimes(0);
  });

  it("acquire failure", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const error = new Error("acquire failed");
    pool.acquire = vi.fn(async () => {
      throw error;
    });

    const result = await runCopilotSdkAttempt(makeParams(), { pool });

    expect(result.promptError).toBe(error);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(pool.release).toHaveBeenCalledTimes(0);
  });

  it("cleanup on success", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams(), { pool });

    const session = sdk.sessions[0];
    expect(session.off).toHaveBeenCalledTimes(session.on.mock.calls.length);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("cleanup on send error", async () => {
    const error = new Error("send failed");
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockRejectedValueOnce(error);
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(makeParams(), { pool });
    const session = sdk.sessions[0];

    expect(result.promptError).toBe(error);
    expect(session.off).toHaveBeenCalledTimes(session.on.mock.calls.length);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("cleanup on disconnect throw", async () => {
    const primaryError = new Error("send failed");
    const sdkWithPrimaryError = makeFakeSdk({
      onCreateSession: (session) => {
        session.disconnect.mockRejectedValueOnce(new Error("disconnect failed"));
        session.sendAndWait.mockRejectedValueOnce(primaryError);
      },
    });
    const poolWithPrimaryError = makeFakePool(sdkWithPrimaryError);

    const first = await runCopilotSdkAttempt(makeParams(), { pool: poolWithPrimaryError });
    expect(first.promptError).toBe(primaryError);

    const sdkWithoutPrimaryError = makeFakeSdk({
      onCreateSession: (session) => {
        session.disconnect.mockRejectedValueOnce(new Error("disconnect failed"));
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
      },
    });
    const poolWithoutPrimaryError = makeFakePool(sdkWithoutPrimaryError);

    const second = await runCopilotSdkAttempt(makeParams(), { pool: poolWithoutPrimaryError });
    expect((second.promptError as Error | undefined)?.message).toBe("disconnect failed");
  });

  it("pool keying: useLoggedInUser", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(
      makeParams({ auth: { gitHubToken: "ignored", useLoggedInUser: true } as never }),
      { pool },
    );

    const key = pool.acquire.mock.calls[0]?.[0] as { authMode: string };
    const options = pool.acquire.mock.calls[0]?.[1] as {
      gitHubToken?: string;
      useLoggedInUser?: boolean;
    };
    expect(key.authMode).toBe("useLoggedInUser");
    expect(options.useLoggedInUser).toBe(true);
    expect(options.gitHubToken).toBeUndefined();
  });

  it("pool keying: gitHubToken requires profileId+profileVersion", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await expect(
      runCopilotSdkAttempt(makeParams({ auth: { gitHubToken: "token" } as never }), { pool }),
    ).rejects.toThrow(
      "[copilot-sdk-attempt] gitHubToken auth requires profileId+profileVersion (pool keying safety; per Q5/Q1 decisions)",
    );
    expect(pool.acquire).toHaveBeenCalledTimes(0);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
  });

  it("pool keying: gitHubToken with profile", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(
      makeParams({
        auth: { gitHubToken: "token", profileId: "profile-1", profileVersion: "v1" } as never,
      }),
      { pool },
    );

    const key = pool.acquire.mock.calls[0]?.[0] as {
      authMode: string;
      authProfileId?: string;
      authProfileVersion?: string;
    };
    const options = pool.acquire.mock.calls[0]?.[1] as {
      gitHubToken?: string;
      useLoggedInUser?: boolean;
    };
    expect(key.authMode).toBe("gitHubToken");
    expect(key.authProfileId).toBe("profile-1");
    expect(key.authProfileVersion).toBe("v1");
    expect(options.gitHubToken).toBe("token");
    expect(options.useLoggedInUser).toBe(false);
  });
});
