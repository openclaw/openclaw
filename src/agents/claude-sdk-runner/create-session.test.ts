/**
 * Session Lifecycle Contract Tests
 *
 * Derived from: implementation-plan.md Section 4.1 (createClaudeSdkSession pseudocode),
 * Section 4.4 (session state architecture: resume not history concatenation, session ID persistence),
 * Section 11.1 (ClaudeSdkSession type contract),
 * claude-agent-sdk-api.md Section 2 (session ID lifecycle, resume parameter),
 * pi-runtime-baseline.md Section 3 (session interface surface used by attempt.ts).
 */

import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import type { ClaudeSdkSessionParams } from "./types.js";

// ---------------------------------------------------------------------------
// Mock the Agent SDK query() function
// ---------------------------------------------------------------------------

// We use a factory that returns an async generator yielding mock SDKMessages
function makeMockQueryGen(messages: Array<Record<string, unknown>>) {
  return async function* () {
    for (const msg of messages) {
      yield msg;
    }
  };
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn(),
    createSdkMcpServer: vi.fn(() => ({ name: "mock-mcp-server", type: "mock" })),
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => ({
      name,
      handler,
    })),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

async function importCreateSession() {
  const mod = await import("./create-session.js");
  return mod.createClaudeSdkSession;
}

async function importQuery() {
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  return mod.query as Mock;
}

async function importCreateSdkMcpServer() {
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  return mod.createSdkMcpServer as Mock;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeParams(overrides?: Partial<ClaudeSdkSessionParams>): ClaudeSdkSessionParams {
  return {
    workspaceDir: "/workspace",
    sessionId: "sess_local_001",
    modelId: "claude-sonnet-4-5-20250514",
    tools: [],
    customTools: [],
    systemPrompt: "You are a helpful assistant.",
    sessionManager: {
      appendMessage: vi.fn(() => "msg-id"),
    },
    ...overrides,
  };
}

function buildImageHash(mimeType: string, data: string): string {
  return createHash("sha256").update(mimeType).update(":").update(data).digest("hex");
}

function buildImageFilename(index: number, hash: string): string {
  return `openclaw-image-${index + 1}-${hash.slice(0, 12)}.png`;
}

const INIT_MESSAGES = [
  { type: "system", subtype: "init", session_id: "sess_server_abc123" },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
  },
  { type: "result", subtype: "success", result: "Hello!" },
];

afterEach(() => {
  vi.unstubAllEnvs();
  resetDiagnosticEventsForTest();
});

// ---------------------------------------------------------------------------
// Section 3.1: Session Creation and Resume
// ---------------------------------------------------------------------------

describe("session lifecycle — session creation and resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures session_id from Agent SDK init event", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    await session.prompt("Hello");
    expect(session.claudeSdkSessionId).toBe("sess_server_abc123");
  });

  it("passes resume parameter on subsequent prompt() calls", async () => {
    const queryMock = await importQuery();
    // First call: returns session_id via init
    queryMock.mockImplementationOnce(() => makeMockQueryGen(INIT_MESSAGES)());
    // Second call: should be called with resume option
    queryMock.mockImplementationOnce(() =>
      makeMockQueryGen([{ type: "result", subtype: "success", result: "done" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    // First prompt — captures session_id
    await session.prompt("First question");
    expect(session.claudeSdkSessionId).toBe("sess_server_abc123");

    // Second prompt — should pass resume
    await session.prompt("Follow up question");
    expect(queryMock).toHaveBeenCalledTimes(2);
    const secondCall = queryMock.mock.calls[1];
    expect(secondCall[0].options?.resume).toBe("sess_server_abc123");
  });

  it("passes workspaceDir as query cwd", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ workspaceDir: "/tmp/openclaw-workspace" }));

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    expect(call[0].options?.cwd).toBe("/tmp/openclaw-workspace");
  });

  it("merges caller-provided mcpServers with internal openclaw-tools bridge", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const externalServer = { type: "sse", url: "http://localhost:3001/mcp" };
    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        mcpServers: { "external-db": externalServer },
      }),
    );

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    const servers = call[0].options?.mcpServers as Record<string, unknown>;
    // External server is present
    expect(servers["external-db"]).toBe(externalServer);
    // Internal openclaw-tools bridge is always present
    expect(servers["openclaw-tools"]).toBeDefined();
  });

  it("openclaw-tools cannot be overwritten by caller mcpServers", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        mcpServers: { "openclaw-tools": { type: "fake", url: "http://evil" } },
      }),
    );

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    const servers = call[0].options?.mcpServers as Record<string, unknown>;
    // openclaw-tools must be the INTERNAL bridge, not the caller's fake
    const server = servers["openclaw-tools"] as { type: string };
    expect(server.type).not.toBe("fake");
  });

  it("does NOT concatenate message history into prompt text", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementationOnce(() => makeMockQueryGen(INIT_MESSAGES)());
    queryMock.mockImplementationOnce(() =>
      makeMockQueryGen([{ type: "result", subtype: "success", result: "done" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    // Simulate some messages history
    session.replaceMessages([
      { role: "user", content: [{ type: "text", text: "Earlier message" }] },
      { role: "assistant", content: [{ type: "text", text: "Earlier response" }] },
    ] as never[]);

    await session.prompt("First question");
    await session.prompt("New question");

    // The second query call should have prompt as exactly "New question" — no history
    const secondCall = queryMock.mock.calls[1];
    expect(secondCall[0].prompt).toBe("New question");
    // history must NOT be in the prompt string
    expect(secondCall[0].prompt).not.toContain("Earlier message");
    expect(secondCall[0].prompt).not.toContain("Earlier response");
  });

  it("setSystemPrompt() updates systemPrompt for subsequent query() calls", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success", result: "done" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ systemPrompt: "Original prompt" }));

    await session.prompt("First question");
    session.setSystemPrompt?.("Updated prompt");
    await session.prompt("Second question");

    expect(queryMock.mock.calls[0]?.[0]?.options?.systemPrompt).toBe("Original prompt");
    expect(queryMock.mock.calls[1]?.[0]?.options?.systemPrompt).toBe("Updated prompt");
  });

  it("persists session_id via sessionManager.appendCustomEntry on dispose()", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const appendCustomEntry = vi.fn();
    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        sessionManager: { appendCustomEntry },
      }),
    );

    await session.prompt("Hello");
    session.dispose();

    expect(appendCustomEntry).toHaveBeenCalledWith(
      "openclaw:claude-sdk-session-id",
      "sess_server_abc123",
    );
  });

  it("loads session_id from claudeSdkResumeSessionId on first prompt call", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success", result: "done" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        claudeSdkResumeSessionId: "sess_prev_999",
      }),
    );

    await session.prompt("First message");

    // Should call query with resume = "sess_prev_999"
    const firstCall = queryMock.mock.calls[0];
    expect(firstCall[0].options?.resume).toBe("sess_prev_999");
  });
});

describe("session lifecycle — thinking token budget mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps low/basic thinking to ~4k tokens", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ thinkLevel: "low" }));

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    expect(call[0].options?.maxThinkingTokens).toBe(4000);
  });

  it("maps medium/deep thinking to ~10k tokens", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ thinkLevel: "medium" }));

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    expect(call[0].options?.maxThinkingTokens).toBe(10000);
  });

  it("maps high thinking to ~40k tokens", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ thinkLevel: "high" }));

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    expect(call[0].options?.maxThinkingTokens).toBe(40000);
  });

  it("maps off thinking to no thinking token budget", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ thinkLevel: "off" }));

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    expect(call[0].options?.maxThinkingTokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Section 3.2: Session Interface Compatibility
// ---------------------------------------------------------------------------

describe("session lifecycle — interface compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("session has all required properties for attempt.ts duck-typed interface", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen([])());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    expect(typeof session.prompt).toBe("function");
    expect(typeof session.steer).toBe("function");
    expect(typeof session.abort).toBe("function");
    expect(typeof session.dispose).toBe("function");
    expect(typeof session.subscribe).toBe("function");
    expect(typeof session.abortCompaction).toBe("function");
    expect(typeof session.isStreaming).toBe("boolean");
    expect(typeof session.isCompacting).toBe("boolean");
    expect(Array.isArray(session.messages)).toBe(true);
    expect(typeof session.sessionId).toBe("string");
    expect(typeof session.replaceMessages).toBe("function");
    expect(typeof session.setSystemPrompt).toBe("function");
    expect(session.runtimeHints).toBeDefined();
    expect(typeof session.runtimeHints.allowSyntheticToolResults).toBe("boolean");
    expect(typeof session.runtimeHints.enforceFinalTag).toBe("boolean");
    expect(typeof session.runtimeHints.managesOwnHistory).toBe("boolean");
    expect(typeof session.runtimeHints.supportsStreamFnWrapping).toBe("boolean");
    expect(session.runtimeHints.managesOwnHistory).toBe(true);
    expect(session.runtimeHints.supportsStreamFnWrapping).toBe(false);
  });

  it("runtimeHints.sessionFile is set when provided", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen([])());

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        sessionFile: "/tmp/test-session.jsonl",
      }),
    );

    expect(session.runtimeHints.sessionFile).toBe("/tmp/test-session.jsonl");
  });

  it("replaceMessages updates local messages array without API call", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen([])());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    const msg = { role: "assistant", content: [{ type: "text", text: "hi" }] };
    session.replaceMessages([msg] as never[]);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toEqual(msg);
    // No additional API calls triggered by replaceMessages
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("subscribe returns an unsubscribe function that stops event delivery", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    const received: unknown[] = [];
    const unsub = session.subscribe((evt: unknown) => {
      received.push(evt);
    });

    expect(typeof unsub).toBe("function");
    unsub();

    await session.prompt("Hello");
    // After unsubscribe, no events received
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Section 3.3: Abort and Control
// ---------------------------------------------------------------------------

describe("session lifecycle — abort and control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("isStreaming is false before prompt() and false after", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());
    expect(session.isStreaming).toBe(false);
    const promptPromise = session.prompt("Hello");
    await promptPromise;
    expect(session.isStreaming).toBe(false);
  });

  it("steer() queues text for next prompt", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    await session.steer("additional context");
    // Steer queues text — it should be incorporated in the next prompt call
    // Verify the steer doesn't throw
    expect(session.isStreaming).toBe(false);
  });

  it("steer() mid-loop does not interrupt current query and applies on next prompt", async () => {
    const queryMock = await importQuery();

    const firstQueryMessages = [
      { type: "system", subtype: "init", session_id: "sess_steer_1" },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Working on it..." }] },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Still going..." }] },
      },
      { type: "result", subtype: "success" },
    ];
    const secondQueryMessages = [{ type: "result", subtype: "success" }];
    queryMock
      .mockImplementationOnce(() => makeMockQueryGen(firstQueryMessages)())
      .mockImplementationOnce(() => makeMockQueryGen(secondQueryMessages)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    // Queue steer while prompt() is still running.
    let assistantCount = 0;
    session.subscribe((evt: unknown) => {
      const e = evt as { type: string };
      if (e.type === "message_end") {
        assistantCount++;
        if (assistantCount === 1) {
          void session.steer("urgent: change direction");
        }
      }
    });

    await session.prompt("Initial task");
    await session.prompt("Follow-up task");

    // query() is called once per prompt (no mid-loop interrupt/resume path).
    expect(queryMock).toHaveBeenCalledTimes(2);
    // Second prompt should include queued steer text.
    const secondCall = queryMock.mock.calls[1];
    expect(secondCall[0].prompt).toBe("urgent: change direction\n\nFollow-up task");
    // Second call resumes the same SDK session.
    expect(secondCall[0].options?.resume).toBe("sess_steer_1");
  });

  it("abort() calls queryInstance.interrupt() to cancel in-flight SDK query", async () => {
    const queryMock = await importQuery();
    let interruptCalled = false;
    // Create a generator that blocks until abort, simulating a long-running query
    const blockingGen = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        // Wait a tick to let abort fire
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { value: { type: "result", subtype: "end" }, done: false };
      },
      async return() {
        return { value: undefined, done: true };
      },
      interrupt: vi.fn(async () => {
        interruptCalled = true;
      }),
    };
    queryMock.mockReturnValue(blockingGen);

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    const promptPromise = session.prompt("Hello");
    // Abort after a microtask to ensure prompt() has started
    await new Promise((resolve) => setTimeout(resolve, 10));
    void session.abort();
    await promptPromise;

    expect(interruptCalled).toBe(true);
  });

  it("rejects concurrent prompt() calls while a prompt is in-flight", async () => {
    const queryMock = await importQuery();
    let resolveNext: (() => void) | undefined;
    const waitForNext = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    const iter = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        await waitForNext;
        return { done: true as const, value: undefined };
      },
      async return() {
        return { done: true as const, value: undefined };
      },
      interrupt: vi.fn(async () => {}),
    };
    queryMock.mockReturnValue(iter);

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    const firstPrompt = session.prompt("First");
    await Promise.resolve();
    await expect(session.prompt("Second")).rejects.toThrow("already has an in-flight prompt");
    resolveNext?.();
    await firstPrompt;
  });

  it("treats pre-signaled abort controllers as a no-op completion", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation((input: { options: { abortController: AbortController } }) => {
      input.options.abortController.abort();
      return makeMockQueryGen([{ type: "result", subtype: "success", result: "ignored" }])();
    });

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    await expect(session.prompt("Hello")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Section 3.4: Messages state updated during prompt
// ---------------------------------------------------------------------------

describe("session lifecycle — messages state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends assistant messages to state.messages during prompt()", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([
        { type: "system", subtype: "init", session_id: "sess_1" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello! How can I help?" }],
          },
        },
        { type: "result", subtype: "success" },
      ])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    expect(session.messages).toHaveLength(0);
    await session.prompt("Hello");

    // After prompt, messages should contain the assistant response
    expect(session.messages.length).toBeGreaterThan(0);
    const lastMsg = session.messages[session.messages.length - 1] as {
      role: string;
      content: Array<{ type: string; text?: string }>;
    };
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "Hello! How can I help?" }),
      ]),
    );
  });

  it("appends user prompt to state.messages before assistant output", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([
        { type: "system", subtype: "init", session_id: "sess_1" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            model: "claude-sonnet-test",
            stop_reason: "end_turn",
          },
        },
        { type: "result", subtype: "success" },
      ])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    await session.prompt("Hello");

    expect(session.messages[0]).toMatchObject({
      role: "user",
      content: "Hello",
    });
    expect(session.messages[1]).toMatchObject({
      role: "assistant",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-sonnet-test",
      stopReason: "stop",
    });
  });

  it("uses params.provider for transcript metadata when provided", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([
        { type: "system", subtype: "init", session_id: "sess_2" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            model: "claude-sonnet-test",
            stop_reason: "end_turn",
          },
        },
        { type: "result", subtype: "success" },
      ])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ provider: "openrouter" }));

    await session.prompt("Hello");

    expect(session.messages[1]).toMatchObject({
      role: "assistant",
      provider: "openrouter",
      api: "claude-sdk",
    });
  });
});

// ---------------------------------------------------------------------------
// Section 3.5: Multimodal image input
// ---------------------------------------------------------------------------

describe("session lifecycle — multimodal images", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends images via structured multimodal user message blocks", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    await session.prompt("What's in this image?", {
      images: [{ type: "image", media_type: "image/png", data: "iVBOR_base64data" }],
    } as never);

    const call = queryMock.mock.calls[0];
    const options = call[0].options as Record<string, unknown>;
    expect(options.images).toBeUndefined();
    const prompt = call[0].prompt as string | AsyncIterable<Record<string, unknown>>;
    expect(typeof prompt).not.toBe("string");
    if (typeof prompt === "string") {
      throw new Error("expected structured SDK prompt stream for image input");
    }
    const first = await prompt[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    const userMessage = first.value as {
      type: string;
      session_id: string;
      parent_tool_use_id: string | null;
      message: {
        role: string;
        content: Array<
          | { type: "text"; text: string }
          | {
              type: "image";
              source: { type: "base64"; media_type: string; data: string };
            }
        >;
      };
    };
    expect(userMessage.type).toBe("user");
    expect(userMessage.session_id).toBe("");
    expect(userMessage.parent_tool_use_id).toBeNull();
    expect(userMessage.message.role).toBe("user");
    expect(userMessage.message.content[0]).toEqual({
      type: "text",
      text: "What's in this image?",
    });
    expect(userMessage.message.content[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "iVBOR_base64data",
      },
    });
    expect(JSON.stringify(userMessage.message.content)).not.toContain("data:image/");
  });

  it("persists image prompts in Pi-style user content blocks", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const appendMessage = vi.fn(() => "msg-id");
    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        sessionManager: { appendMessage },
      }),
    );

    await session.prompt("Describe this", {
      images: [{ type: "image", media_type: "image/png", data: "iVBOR_base64data" }],
    } as never);

    const userCall = appendMessage.mock.calls.find(
      (c: unknown[]) => (c[0] as { role?: string }).role === "user",
    ) as unknown[] | undefined;
    expect(userCall).toBeDefined();
    const userMessage = (userCall as unknown[])[0] as {
      role: string;
      content:
        | string
        | Array<
            { type: "text"; text?: string } | { type: "image"; data?: string; mimeType?: string }
          >;
    };
    expect(userMessage.role).toBe("user");
    expect(Array.isArray(userMessage.content)).toBe(true);
    const content = userMessage.content as Array<
      { type: "text"; text?: string } | { type: "image"; data?: string; mimeType?: string }
    >;
    expect(content[0]).toEqual({ type: "text", text: "Describe this" });
    expect(content[1]).toEqual({
      type: "image",
      data: "iVBOR_base64data",
      mimeType: "image/png",
    });
    expect((content[0] as { text?: string }).text ?? "").not.toContain("data:image/");
  });
});

// ---------------------------------------------------------------------------
// Section 3.6: Provider env wiring
// ---------------------------------------------------------------------------

describe("session lifecycle — provider env wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets a sanitized env for claude-sdk provider", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-inherited");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "oauth-token");

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        claudeSdkConfig: {},
      }),
    );

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    const options = call[0].options as Record<string, unknown>;
    const env = options["env"] as Record<string, string>;
    expect(env).toBeDefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
  });

  it("uses process CLAUDE_CONFIG_DIR when config does not override it", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/from-process-env");

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        claudeSdkConfig: {},
      }),
    );

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    const options = call[0].options as Record<string, unknown>;
    const env = options["env"] as Record<string, string>;
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/tmp/from-process-env");
  });

  it("uses claudeSdk.configDir over process CLAUDE_CONFIG_DIR", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/from-process-env");

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        claudeSdkConfig: {
          configDir: "/tmp/from-agent-config",
        },
      }),
    );

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    const options = call[0].options as Record<string, unknown>;
    const env = options["env"] as Record<string, string>;
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/tmp/from-agent-config");
  });

  it("forwards non-claude model ids for claude-sdk provider", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        modelId: "MiniMax-M2.5",
        claudeSdkConfig: {},
      }),
    );

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    const options = call[0].options as Record<string, unknown>;
    expect(options["model"]).toBe("MiniMax-M2.5");
  });
});

// ---------------------------------------------------------------------------
// Parity gap guards — these tests encode expected end-state behavior.
// Some may fail until runtime parity fixes are implemented.
// ---------------------------------------------------------------------------

describe("session lifecycle — parity guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables Claude built-in tools so OpenClaw MCP tools are the only execution path", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    const options = call[0].options as Record<string, unknown>;
    expect(options.tools).toEqual([]);
  });

  it("throws when SDK returns result subtype error_* so failures do not look successful", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([
        { type: "system", subtype: "init", session_id: "sess_err_1" },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Tool execution failed"],
        },
      ])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    await expect(session.prompt("Hello")).rejects.toThrow("Tool execution failed");
    const errorAssistant = session.messages.find(
      (msg) =>
        (msg as { role?: string }).role === "assistant" &&
        (msg as { stopReason?: string }).stopReason === "error",
    ) as { errorMessage?: string; provider?: string; api?: string } | undefined;
    expect(errorAssistant).toBeDefined();
    expect(errorAssistant?.errorMessage).toBe("Tool execution failed");
    expect(errorAssistant?.provider).toBe("anthropic");
    expect(errorAssistant?.api).toBe("anthropic-messages");
  });

  it("throws result text when SDK marks is_error true with subtype success", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([
        { type: "system", subtype: "init", session_id: "sess_err_2" },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Prompt is too long",
        },
      ])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    await expect(session.prompt("Hello")).rejects.toThrow("Prompt is too long");
  });

  it("prefers SDK result error message over trailing process exit code errors", async () => {
    const queryMock = await importQuery();
    let emittedResult = false;
    const iter = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (!emittedResult) {
          emittedResult = true;
          return {
            done: false as const,
            value: {
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              errors: ["Model validation failed"],
            },
          };
        }
        throw new Error("Claude Code process exited with code 1");
      },
      async return() {
        return { done: true as const, value: undefined };
      },
      interrupt: vi.fn(async () => {}),
    };
    queryMock.mockReturnValue(iter);

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    await expect(session.prompt("Hello")).rejects.toThrow("Model validation failed");
  });

  it("does not pass unsupported stream params through query options in claude-sdk mode", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        extraParams: {
          temperature: 0.2,
          maxTokens: 256,
        },
      }),
    );

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    const options = call[0].options as Record<string, unknown>;
    expect(options).not.toHaveProperty("temperature");
    expect(options).not.toHaveProperty("maxTokens");
  });

  it("adds spawnClaudeCodeProcess diagnostics hook to query options", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    const options = call[0].options as Record<string, unknown>;
    expect(typeof options.spawnClaudeCodeProcess).toBe("function");
  });

  it("caps captured stderr tail when enriching process exit errors", async () => {
    expect.hasAssertions();
    const queryMock = await importQuery();
    queryMock.mockImplementation((input: { options: { stderr?: (data: string) => void } }) => {
      input.options.stderr?.(`${"x".repeat(5000)}tail-marker`);
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          throw new Error("Claude Code process exited with code 1");
        },
        async return() {
          return { done: true as const, value: undefined };
        },
        interrupt: vi.fn(async () => {}),
      };
    });

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    await session.prompt("Hello").catch((err: Error) => {
      expect(err.message).toContain("Subprocess stderr:");
      expect(err.message).toContain("tail-marker");
      const stderrTail = err.message.split("Subprocess stderr: ")[1] ?? "";
      expect(stderrTail.length).toBeLessThanOrEqual(4096);
    });
  });
});

// ---------------------------------------------------------------------------
// Section 4.1: Streaming configuration
// ---------------------------------------------------------------------------

describe("session lifecycle — streaming configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes includePartialMessages: true in query options", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams());

    await session.prompt("Hello");

    const call = queryMock.mock.calls[0];
    const options = call[0].options as Record<string, unknown>;
    expect(options.includePartialMessages).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 4.2: User message persistence
// ---------------------------------------------------------------------------

describe("session lifecycle — user message persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists user message via appendMessage before query", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const appendMessage = vi.fn(() => "msg-id");
    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        sessionManager: { appendMessage },
      }),
    );

    await session.prompt("Hello agent");

    // appendMessage should have been called with user message
    const userCall = appendMessage.mock.calls.find(
      (c: unknown[]) => (c[0] as { role: string }).role === "user",
    );
    expect(userCall).toBeDefined();
    const userMsg = (userCall as unknown[])[0] as {
      role: string;
      content: string;
      timestamp: number;
    };
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toBe("Hello agent");
    expect(typeof userMsg.timestamp).toBe("number");
  });

  it("does not throw when sessionManager is undefined", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ sessionManager: undefined }));

    await expect(session.prompt("Hello")).resolves.not.toThrow();
  });
});

describe("session lifecycle — tool correlation cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears pending tool_use ids after turn completion so stale IDs are not reused", async () => {
    const queryMock = await importQuery();
    const createSdkMcpServerMock = await importCreateSdkMcpServer();
    const toolExecute = vi.fn().mockResolvedValue("ok");

    queryMock.mockImplementation(() =>
      makeMockQueryGen([
        { type: "system", subtype: "init", session_id: "sess_cleanup_1" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_stale_1", name: "read_file", input: {} }],
          },
        },
        { type: "result", subtype: "success" },
      ])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        tools: [
          {
            name: "read_file",
            description: "Read file",
            parameters: {},
            execute: toolExecute,
          },
        ] as never[],
      }),
    );

    await session.prompt("trigger tool_use only");

    const mcpConfig = createSdkMcpServerMock.mock.calls[0]?.[0] as {
      tools: Array<{
        name: string;
        handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
      }>;
    };
    const readFile = mcpConfig.tools.find((t) => t.name === "read_file");
    expect(readFile).toBeDefined();

    const result = (await readFile!.handler({ path: "/tmp/a" }, {})) as {
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    };

    expect(toolExecute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('"code":"missing_tool_use_id"');
  });
});

// ---------------------------------------------------------------------------
// Section 4.3: Streaming integration — stream_event messages produce real-time
// events AND the complete assistant message triggers persistence
// ---------------------------------------------------------------------------

describe("session lifecycle — streaming integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stream_event messages produce real-time events and assistant triggers persistence", async () => {
    const queryMock = await importQuery();

    const streamingMessages = [
      { type: "system", subtype: "init", session_id: "sess_stream_1" },
      // Stream events
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "claude-sonnet-4-5-20250514" },
        },
      },
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      },
      {
        type: "stream_event",
        event: { type: "message_stop" },
      },
      // Complete assistant message (triggers persistence)
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      { type: "result", subtype: "success" },
    ];
    queryMock.mockImplementation(() => makeMockQueryGen(streamingMessages)());

    const appendMessage = vi.fn(() => "msg-id");
    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        sessionManager: { appendMessage },
      }),
    );

    const receivedEvents: Array<Record<string, unknown>> = [];
    session.subscribe((evt: unknown) => {
      receivedEvents.push(evt as Record<string, unknown>);
    });

    await session.prompt("Hello");

    // Real-time events were emitted from stream_event messages
    const eventTypes = receivedEvents.map((e) => e.type);
    expect(eventTypes).toContain("message_start");
    expect(eventTypes).toContain("message_update");
    expect(eventTypes).toContain("message_end");

    // But the complete assistant message did NOT re-emit message_start/end
    // (dedup logic). Count message_start occurrences — should be exactly 1.
    const messageStartCount = eventTypes.filter((t) => t === "message_start").length;
    expect(messageStartCount).toBe(1);

    // Persistence was triggered — appendMessage called with assistant message
    const assistantCall = appendMessage.mock.calls.find(
      (c: unknown[]) => (c[0] as { role: string }).role === "assistant",
    );
    expect(assistantCall).toBeDefined();
    const persistedMsg = (assistantCall as unknown[])[0] as { role: string; api: string };
    expect(persistedMsg.api).toBe("anthropic-messages");
  });
});

// ---------------------------------------------------------------------------
// Concern #6: Steer queue persisted on next prompt turn
// ---------------------------------------------------------------------------

describe("session lifecycle — steer next-turn persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists queued steer text when the next prompt begins", async () => {
    const queryMock = await importQuery();

    queryMock
      .mockImplementationOnce(() =>
        makeMockQueryGen([
          { type: "system", subtype: "init", session_id: "sess_steer_persist" },
          { type: "result", subtype: "success" },
        ])(),
      )
      .mockImplementationOnce(() => makeMockQueryGen([{ type: "result", subtype: "success" }])());

    const appendMessage = vi.fn(() => "msg-id");
    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ sessionManager: { appendMessage } }));

    await session.prompt("Initial task");
    await session.steer("new direction");
    await session.prompt("Follow-up");

    const userCalls = appendMessage.mock.calls.filter(
      (c: unknown[]) => (c[0] as { role: string }).role === "user",
    );
    // Verify second turn persisted the steer-prefixed prompt content.
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(userCalls.length).toBe(2);
    const steerCall = userCalls[1] as unknown[];
    expect((steerCall[0] as { content: string }).content).toBe("new direction\n\nFollow-up");
  });
});

// ---------------------------------------------------------------------------
// Concern #15: dispose() warns when session_id never captured
// ---------------------------------------------------------------------------

describe("session lifecycle — dispose warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispose() does not call appendCustomEntry when no session_id was captured", async () => {
    const queryMock = await importQuery();
    // Return messages without init event (no session_id captured)
    queryMock.mockImplementation(() =>
      makeMockQueryGen([
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        },
        { type: "result", subtype: "success" },
      ])(),
    );

    const appendCustomEntry = vi.fn();
    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ sessionManager: { appendCustomEntry } }));

    await session.prompt("Hello");
    session.dispose();

    // Should NOT have persisted a session_id (none was captured)
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });

  it("dispose() returns silently when no messages and no session_id", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen([])());

    const appendCustomEntry = vi.fn();
    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ sessionManager: { appendCustomEntry } }));

    // No prompt() called — no messages, no session_id
    session.dispose();
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });

  it("dispose() is idempotent after persisting session_id", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() => makeMockQueryGen(INIT_MESSAGES)());

    const appendCustomEntry = vi.fn();
    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ sessionManager: { appendCustomEntry } }));

    await session.prompt("Hello");
    session.dispose();
    session.dispose();

    expect(appendCustomEntry).toHaveBeenCalledTimes(1);
    expect(appendCustomEntry).toHaveBeenCalledWith(
      "openclaw:claude-sdk-session-id",
      "sess_server_abc123",
    );
  });
});

// ---------------------------------------------------------------------------
// Bug 1: Thread context prefix stripping for resuming sessions
// ---------------------------------------------------------------------------

describe("prompt() — thread context prefix stripping for resuming sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("strips [Thread history - for context] prefix when session was created with a resume ID", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({ claudeSdkResumeSessionId: "existing-session-id" }),
    );

    await session.prompt(
      "[Thread history - for context]\nuser: prev\nassistant: prev reply\n\nActual message",
    );

    const call = queryMock.mock.calls[0];
    const prompt = call[0].prompt;
    // The SDK receives the stripped prompt string
    expect(typeof prompt).toBe("string");
    expect(prompt).toBe("Actual message");
    expect(prompt).not.toContain("[Thread history - for context]");
  });

  it("strips [Thread starter - for context] prefix when session was created with a resume ID", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({ claudeSdkResumeSessionId: "existing-session-id" }),
    );

    await session.prompt(
      "[Thread starter - for context]\nOriginal thread message\n\nFollow up question",
    );

    const call = queryMock.mock.calls[0];
    const prompt = call[0].prompt;
    expect(typeof prompt).toBe("string");
    expect(prompt).toBe("Follow up question");
    expect(prompt).not.toContain("[Thread starter - for context]");
  });

  it("does NOT strip prefix when session was created without a resume ID (first turn)", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const createSession = await importCreateSession();
    // No claudeSdkResumeSessionId — fresh session
    const session = await createSession(makeParams());

    const fullPrompt =
      "[Thread history - for context]\nuser: hello\nassistant: hi\n\nActual message";
    await session.prompt(fullPrompt);

    const call = queryMock.mock.calls[0];
    const prompt = call[0].prompt;
    expect(prompt).toBe(fullPrompt);
    expect(prompt).toContain("[Thread history - for context]");
  });

  it("preserves the actual message body after stripping", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({ claudeSdkResumeSessionId: "existing-session-id" }),
    );

    await session.prompt(
      "[Thread history - for context]\nuser: hello\nassistant: hi\n\nDo the thing please",
    );

    const call = queryMock.mock.calls[0];
    expect(call[0].prompt).toBe("Do the thing please");
  });

  it("returns prompt unchanged when no separator is present (malformed prefix, do not drop message)", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({ claudeSdkResumeSessionId: "existing-session-id" }),
    );

    const malformed = "[Thread history - for context]\nNo double-newline separator here";
    await session.prompt(malformed);

    const call = queryMock.mock.calls[0];
    // No separator → strip is a no-op → message preserved
    expect(call[0].prompt).toBe(malformed);
  });

  it("does not strip when prompt has no thread context prefix", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({ claudeSdkResumeSessionId: "existing-session-id" }),
    );

    await session.prompt("Plain message without prefix");

    const call = queryMock.mock.calls[0];
    expect(call[0].prompt).toBe("Plain message without prefix");
  });

  it("strips thread context even when media preamble lines appear before the marker", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({ claudeSdkResumeSessionId: "existing-session-id" }),
    );

    await session.prompt(
      [
        "[media attached: image.png (image/png) | https://example.com/image.png]",
        "To send an image back, prefer the message tool.",
        "[Thread history - for context]",
        "user: previous",
        "assistant: previous reply",
        "",
        "Current user request",
      ].join("\n"),
    );

    const call = queryMock.mock.calls[0];
    expect(call[0].prompt).toBe(
      [
        "[media attached: image.png (image/png) | https://example.com/image.png]",
        "To send an image back, prefer the message tool.",
        "Current user request",
      ].join("\n"),
    );
  });

  it("strips thread context even when hook prepend lines appear before the marker", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({ claudeSdkResumeSessionId: "existing-session-id" }),
    );

    await session.prompt(
      [
        "[Hook context]",
        "channel=signal",
        "[Thread starter - for context]",
        "original message",
        "",
        "User asks for follow-up",
      ].join("\n"),
    );

    const call = queryMock.mock.calls[0];
    expect(call[0].prompt).toBe(
      ["[Hook context]", "channel=signal", "User asks for follow-up"].join("\n"),
    );
  });

  it("does not strip malformed marker segments when marker is not line-aligned", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({ claudeSdkResumeSessionId: "existing-session-id" }),
    );

    const malformed =
      "Prefix text [Thread history - for context]\nuser: prev\nassistant: prev\n\nBody";
    await session.prompt(malformed);

    const call = queryMock.mock.calls[0];
    expect(call[0].prompt).toBe(malformed);
  });
});

describe("prompt() — media persistence strategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses persisted file references on later turns when files_persisted confirms upload", async () => {
    const queryMock = await importQuery();
    queryMock
      .mockImplementationOnce(() =>
        makeMockQueryGen([
          { type: "system", subtype: "init", session_id: "sess_media_1" },
          { type: "system", subtype: "files_persisted", files: [{ file_id: "file_abc123" }] },
          { type: "result", subtype: "success" },
        ])(),
      )
      .mockImplementationOnce(() => makeMockQueryGen([{ type: "result", subtype: "success" }])());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ claudeSdkResumeSessionId: "sess_media_1" }));
    const image = { type: "image", media_type: "image/png", data: "iVBOR_base64data" };

    await session.prompt("Analyze image", { images: [image] } as never);
    await session.prompt("Analyze image again", { images: [image] } as never);

    const secondPrompt = queryMock.mock.calls[1][0].prompt as AsyncIterable<{
      message: { content: Array<{ type: string; source?: Record<string, unknown> }> };
    }>;
    const next = await secondPrompt[Symbol.asyncIterator]().next();
    const content = next.value.message.content;
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "file", file_id: "file_abc123" },
    });
  });

  it("falls back to inline base64 when persistence reports failure", async () => {
    const queryMock = await importQuery();
    queryMock
      .mockImplementationOnce(() =>
        makeMockQueryGen([
          { type: "system", subtype: "init", session_id: "sess_media_2" },
          { type: "system", subtype: "files_persisted", failed: [{ error: "upload failed" }] },
          { type: "result", subtype: "success" },
        ])(),
      )
      .mockImplementationOnce(() => makeMockQueryGen([{ type: "result", subtype: "success" }])());

    const createSession = await importCreateSession();
    const session = await createSession(makeParams({ claudeSdkResumeSessionId: "sess_media_2" }));
    const image = { type: "image", media_type: "image/png", data: "iVBOR_base64data" };

    await session.prompt("Analyze image", { images: [image] } as never);
    await session.prompt("Analyze image again", { images: [image] } as never);

    const secondPrompt = queryMock.mock.calls[1][0].prompt as AsyncIterable<{
      message: { content: Array<{ type: string; source?: Record<string, unknown> }> };
    }>;
    const next = await secondPrompt[Symbol.asyncIterator]().next();
    const content = next.value.message.content;
    expect(content[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "iVBOR_base64data",
      },
    });
  });

  it("hydrates persisted hash->file reference state from custom entries after restart", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const imageData = "iVBOR_base64data";
    const hash = buildImageHash("image/png", imageData);
    const filename = buildImageFilename(0, hash);
    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        provider: "claude-pro",
        claudeSdkResumeSessionId: "sess_media_resume",
        sessionManager: {
          appendMessage: vi.fn(() => "msg-id"),
          getEntries: vi.fn(() => [
            {
              type: "custom",
              customType: "openclaw:claude-sdk-media-ref",
              data: {
                hash,
                filename,
                fileId: "file_from_history",
                sessionId: "sess_media_resume",
                provider: "claude-pro",
                modelId: "claude-sonnet-4-5-20250514",
                updatedAt: Date.now() - 10_000,
              },
            },
          ]),
        },
      }),
    );

    await session.prompt("Analyze restored media", {
      images: [{ type: "image", media_type: "image/png", data: imageData }],
    } as never);

    const prompt = queryMock.mock.calls[0][0].prompt as AsyncIterable<{
      message: { content: Array<{ type: string; source?: Record<string, unknown> }> };
    }>;
    const next = await prompt[Symbol.asyncIterator]().next();
    expect(next.value.message.content[1]).toEqual({
      type: "image",
      source: { type: "file", file_id: "file_from_history" },
    });
  });

  it("recovers hashless media references via deterministic filename mapping", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const imageData = "iVBOR_hashless";
    const hash = buildImageHash("image/png", imageData);
    const filename = buildImageFilename(0, hash);
    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        provider: "claude-pro",
        claudeSdkResumeSessionId: "sess_media_resume",
        sessionManager: {
          appendMessage: vi.fn(() => "msg-id"),
          getEntries: vi.fn(() => [
            {
              type: "custom",
              customType: "openclaw:claude-sdk-media-ref",
              data: {
                filename,
                fileId: "file_hashless",
                sessionId: "sess_media_resume",
                provider: "claude-pro",
                modelId: "claude-sonnet-4-5-20250514",
                updatedAt: Date.now() - 10_000,
              },
            },
          ]),
        },
      }),
    );

    await session.prompt("Analyze restored media", {
      images: [{ type: "image", media_type: "image/png", data: imageData }],
    } as never);

    const prompt = queryMock.mock.calls[0][0].prompt as AsyncIterable<{
      message: { content: Array<{ type: string; source?: Record<string, unknown> }> };
    }>;
    const next = await prompt[Symbol.asyncIterator]().next();
    expect(next.value.message.content[1]).toEqual({
      type: "image",
      source: { type: "file", file_id: "file_hashless" },
    });
  });

  it("does not use recovered file references when resume session id does not match", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const imageData = "iVBOR_mismatch";
    const hash = buildImageHash("image/png", imageData);
    const filename = buildImageFilename(0, hash);
    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        provider: "claude-pro",
        claudeSdkResumeSessionId: "sess_media_current",
        sessionManager: {
          appendMessage: vi.fn(() => "msg-id"),
          getEntries: vi.fn(() => [
            {
              type: "custom",
              customType: "openclaw:claude-sdk-media-ref",
              data: {
                hash,
                filename,
                fileId: "file_other_session",
                sessionId: "sess_media_old",
                provider: "claude-pro",
                modelId: "claude-sonnet-4-5-20250514",
                updatedAt: Date.now() - 10_000,
              },
            },
          ]),
        },
      }),
    );

    await session.prompt("Analyze restored media", {
      images: [{ type: "image", media_type: "image/png", data: imageData }],
    } as never);

    const prompt = queryMock.mock.calls[0][0].prompt as AsyncIterable<{
      message: { content: Array<{ type: string; source?: Record<string, unknown> }> };
    }>;
    const next = await prompt[Symbol.asyncIterator]().next();
    expect(next.value.message.content[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: imageData,
      },
    });
  });

  it("persists resolved media references to session custom entries", async () => {
    const imageData = "iVBOR_base64data";
    const hash = buildImageHash("image/png", imageData);
    const filename = buildImageFilename(0, hash);
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([
        { type: "system", subtype: "init", session_id: "sess_media_persist" },
        {
          type: "system",
          subtype: "files_persisted",
          files: [{ filename, file_id: "file_saved" }],
        },
        { type: "result", subtype: "success" },
      ])(),
    );

    const appendCustomEntry = vi.fn();
    const createSession = await importCreateSession();
    const session = await createSession(
      makeParams({
        claudeSdkResumeSessionId: "sess_media_persist",
        sessionManager: {
          appendMessage: vi.fn(() => "msg-id"),
          appendCustomEntry,
        },
      }),
    );

    await session.prompt("Analyze image", {
      images: [{ type: "image", media_type: "image/png", data: imageData }],
    } as never);

    expect(appendCustomEntry).toHaveBeenCalledWith(
      "openclaw:claude-sdk-media-ref",
      expect.objectContaining({
        hash,
        fileId: "file_saved",
        filename,
      }),
    );
  });

  it("emits runtime.metric diagnostic events for media metrics when diagnostics are enabled", async () => {
    const queryMock = await importQuery();
    queryMock.mockImplementation(() =>
      makeMockQueryGen([{ type: "result", subtype: "success" }])(),
    );

    const createSession = await importCreateSession();
    const events: Array<{ metric: string; fields?: Record<string, unknown> }> = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "runtime.metric") {
        events.push({
          metric: evt.metric,
          fields: evt.fields,
        });
      }
    });
    const session = await createSession(
      makeParams({
        diagnosticsEnabled: true,
        claudeSdkResumeSessionId: "sess_media_diag",
        sessionKey: "agent:test:media-diag",
      }),
    );

    try {
      await session.prompt("Analyze image", {
        images: [{ type: "image", media_type: "image/png", data: "iVBOR_diag" }],
      } as never);
    } finally {
      stop();
    }

    expect(events.some((evt) => evt.metric === "claude_sdk.media.inline_bytes_sent")).toBe(true);
    expect(events.some((evt) => evt.metric === "claude_sdk.media.file_ref_used")).toBe(true);
    const inlineMetric = events.find((evt) => evt.metric === "claude_sdk.media.inline_bytes_sent");
    expect((inlineMetric?.fields?.bytes as number | undefined) ?? 0).toBeGreaterThan(0);
  });
});
