import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";

const streamSimpleMock = vi.fn();
const appendCustomEntryMock = vi.fn();
const buildSessionContextMock = vi.fn();
const getLeafEntryMock = vi.fn();
const branchMock = vi.fn();
const resetLeafMock = vi.fn();
const ensureOpenClawModelsJsonMock = vi.fn();
const discoverAuthStorageMock = vi.fn();
const discoverModelsMock = vi.fn();
const resolveModelWithRegistryMock = vi.fn();
const getApiKeyForModelMock = vi.fn();
const requireApiKeyMock = vi.fn();
const acquireSessionWriteLockMock = vi.fn();
const resolveSessionAuthProfileOverrideMock = vi.fn();
const getActiveEmbeddedRunSnapshotMock = vi.fn();
const waitForEmbeddedPiRunEndMock = vi.fn();
const diagWarnMock = vi.fn();
const diagDebugMock = vi.fn();

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: (...args: unknown[]) => streamSimpleMock(...args),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  SessionManager: {
    open: () => ({
      getLeafEntry: getLeafEntryMock,
      branch: branchMock,
      resetLeaf: resetLeafMock,
      buildSessionContext: buildSessionContextMock,
      appendCustomEntry: appendCustomEntryMock,
    }),
  },
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: (...args: unknown[]) => ensureOpenClawModelsJsonMock(...args),
}));

vi.mock("./pi-model-discovery.js", () => ({
  discoverAuthStorage: (...args: unknown[]) => discoverAuthStorageMock(...args),
  discoverModels: (...args: unknown[]) => discoverModelsMock(...args),
}));

vi.mock("./pi-embedded-runner/model.js", () => ({
  resolveModelWithRegistry: (...args: unknown[]) => resolveModelWithRegistryMock(...args),
}));

vi.mock("./model-auth.js", () => ({
  getApiKeyForModel: (...args: unknown[]) => getApiKeyForModelMock(...args),
  requireApiKey: (...args: unknown[]) => requireApiKeyMock(...args),
}));

vi.mock("./session-write-lock.js", () => ({
  acquireSessionWriteLock: (...args: unknown[]) => acquireSessionWriteLockMock(...args),
}));

vi.mock("./pi-embedded-runner/runs.js", () => ({
  getActiveEmbeddedRunSnapshot: (...args: unknown[]) => getActiveEmbeddedRunSnapshotMock(...args),
  waitForEmbeddedPiRunEnd: (...args: unknown[]) => waitForEmbeddedPiRunEndMock(...args),
}));

vi.mock("./auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: (...args: unknown[]) =>
    resolveSessionAuthProfileOverrideMock(...args),
}));

vi.mock("../logging/diagnostic.js", () => ({
  diagnosticLogger: {
    warn: (...args: unknown[]) => diagWarnMock(...args),
    debug: (...args: unknown[]) => diagDebugMock(...args),
  },
}));

const { BTW_CUSTOM_TYPE, runBtwSideQuestion } = await import("./btw.js");

function makeAsyncEvents(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    sessionFile: "session-1.jsonl",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("runBtwSideQuestion", () => {
  beforeEach(() => {
    streamSimpleMock.mockReset();
    appendCustomEntryMock.mockReset();
    buildSessionContextMock.mockReset();
    getLeafEntryMock.mockReset();
    branchMock.mockReset();
    resetLeafMock.mockReset();
    ensureOpenClawModelsJsonMock.mockReset();
    discoverAuthStorageMock.mockReset();
    discoverModelsMock.mockReset();
    resolveModelWithRegistryMock.mockReset();
    getApiKeyForModelMock.mockReset();
    requireApiKeyMock.mockReset();
    acquireSessionWriteLockMock.mockReset();
    resolveSessionAuthProfileOverrideMock.mockReset();
    getActiveEmbeddedRunSnapshotMock.mockReset();
    waitForEmbeddedPiRunEndMock.mockReset();
    diagWarnMock.mockReset();
    diagDebugMock.mockReset();

    buildSessionContextMock.mockReturnValue({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
    });
    getLeafEntryMock.mockReturnValue(null);
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      api: "anthropic-messages",
    });
    getApiKeyForModelMock.mockResolvedValue({ apiKey: "secret", mode: "api-key", source: "test" });
    requireApiKeyMock.mockReturnValue("secret");
    acquireSessionWriteLockMock.mockResolvedValue({
      release: vi.fn().mockResolvedValue(undefined),
    });
    resolveSessionAuthProfileOverrideMock.mockResolvedValue("profile-1");
    getActiveEmbeddedRunSnapshotMock.mockReturnValue(undefined);
    waitForEmbeddedPiRunEndMock.mockResolvedValue(true);
  });

  it("streams blocks and persists a non-context custom entry", async () => {
    const onBlockReply = vi.fn().mockResolvedValue(undefined);
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "text_delta",
          delta: "Side answer.",
          partial: {
            role: "assistant",
            content: [],
            provider: "anthropic",
            model: "claude-sonnet-4-5",
          },
        },
        {
          type: "text_end",
          content: "Side answer.",
          contentIndex: 0,
          partial: {
            role: "assistant",
            content: [],
            provider: "anthropic",
            model: "claude-sonnet-4-5",
          },
        },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Side answer." }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-5",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    const result = await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: "/tmp/agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      question: "What changed?",
      sessionEntry: createSessionEntry(),
      sessionStore: {},
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
      resolvedThinkLevel: "low",
      resolvedReasoningLevel: "off",
      blockReplyChunking: {
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
      },
      resolvedBlockStreamingBreak: "text_end",
      opts: { onBlockReply },
      isNewSession: false,
    });

    expect(result).toBeUndefined();
    expect(onBlockReply).toHaveBeenCalledWith({
      text: "Side answer.",
      btw: { question: "What changed?" },
    });
    await vi.waitFor(() => {
      expect(appendCustomEntryMock).toHaveBeenCalledWith(
        BTW_CUSTOM_TYPE,
        expect.objectContaining({
          question: "What changed?",
          answer: "Side answer.",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
        }),
      );
    });
  });

  it("returns a final payload when block streaming is unavailable", async () => {
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Final answer." }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-5",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    const result = await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: "/tmp/agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      question: "What changed?",
      sessionEntry: createSessionEntry(),
      resolvedReasoningLevel: "off",
      opts: {},
      isNewSession: false,
    });

    expect(result).toEqual({ text: "Final answer." });
  });

  it("fails when the current branch has no messages", async () => {
    buildSessionContextMock.mockReturnValue({ messages: [] });
    streamSimpleMock.mockReturnValue(makeAsyncEvents([]));

    await expect(
      runBtwSideQuestion({
        cfg: {} as never,
        agentDir: "/tmp/agent",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        question: "What changed?",
        sessionEntry: createSessionEntry(),
        resolvedReasoningLevel: "off",
        opts: {},
        isNewSession: false,
      }),
    ).rejects.toThrow("No active session context.");
  });

  it("uses active-run snapshot messages for BTW context while the main run is in flight", async () => {
    buildSessionContextMock.mockReturnValue({ messages: [] });
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-1",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "write some things then wait 30 seconds and write more" },
          ],
          timestamp: 1,
        },
      ],
    });
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "323" }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-5",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    const result = await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: "/tmp/agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      question: "What is 17 * 19?",
      sessionEntry: createSessionEntry(),
      resolvedReasoningLevel: "off",
      opts: {},
      isNewSession: false,
    });

    expect(result).toEqual({ text: "323" });
    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        systemPrompt: expect.stringContaining("ephemeral /btw side question"),
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({
            role: "user",
            content: [
              {
                type: "text",
                text: expect.stringContaining(
                  "<btw_side_question>\nWhat is 17 * 19?\n</btw_side_question>",
                ),
              },
            ],
          }),
        ]),
      }),
      expect.anything(),
    );
  });

  it("uses the in-flight prompt as background only when there is no prior transcript context", async () => {
    buildSessionContextMock.mockReturnValue({ messages: [] });
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: null,
      messages: [],
      inFlightPrompt: "build me a tic-tac-toe game in brainfuck",
    });
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "You're building a tic-tac-toe game in Brainfuck." }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-5",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    const result = await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: "/tmp/agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      question: "what are we doing?",
      sessionEntry: createSessionEntry(),
      resolvedReasoningLevel: "off",
      opts: {},
      isNewSession: false,
    });

    expect(result).toEqual({ text: "You're building a tic-tac-toe game in Brainfuck." });
    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: "user",
            content: [
              {
                type: "text",
                text: expect.stringContaining(
                  "<in_flight_main_task>\nbuild me a tic-tac-toe game in brainfuck\n</in_flight_main_task>",
                ),
              },
            ],
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it("wraps the side question so the model does not treat it as a main-task continuation", async () => {
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "About 93 million miles." }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-5",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: "/tmp/agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      question: "what is the distance to the sun?",
      sessionEntry: createSessionEntry(),
      resolvedReasoningLevel: "off",
      opts: {},
      isNewSession: false,
    });

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      systemPrompt: expect.stringContaining(
        "Do not continue, resume, or complete any unfinished task",
      ),
    });
    expect(context).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [
            {
              type: "text",
              text: expect.stringContaining(
                "Ignore any unfinished task in the conversation while answering it.",
              ),
            },
          ],
        }),
      ]),
    });
  });

  it("branches away from an unresolved trailing user turn before building BTW context", async () => {
    getLeafEntryMock.mockReturnValue({
      type: "message",
      parentId: "assistant-1",
      message: { role: "user" },
    });
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "323" }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-5",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    const result = await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: "/tmp/agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      question: "What is 17 * 19?",
      sessionEntry: createSessionEntry(),
      resolvedReasoningLevel: "off",
      opts: {},
      isNewSession: false,
    });

    expect(branchMock).toHaveBeenCalledWith("assistant-1");
    expect(resetLeafMock).not.toHaveBeenCalled();
    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ text: "323" });
  });

  it("branches to the active run snapshot leaf when the session is busy", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-seed",
    });
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "323" }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-5",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    const result = await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: "/tmp/agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      question: "What is 17 * 19?",
      sessionEntry: createSessionEntry(),
      resolvedReasoningLevel: "off",
      opts: {},
      isNewSession: false,
    });

    expect(branchMock).toHaveBeenCalledWith("assistant-seed");
    expect(getLeafEntryMock).not.toHaveBeenCalled();
    expect(result).toEqual({ text: "323" });
  });

  it("falls back when the active run snapshot leaf no longer exists", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-gone",
    });
    branchMock.mockImplementationOnce(() => {
      throw new Error("Entry 3235c7c4 not found");
    });
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "323" }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-5",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    const result = await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: "/tmp/agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      question: "What is 17 * 19?",
      sessionEntry: createSessionEntry(),
      resolvedReasoningLevel: "off",
      opts: {},
      isNewSession: false,
    });

    expect(branchMock).toHaveBeenCalledWith("assistant-gone");
    expect(resetLeafMock).toHaveBeenCalled();
    expect(result).toEqual({ text: "323" });
    expect(diagDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("btw snapshot leaf unavailable: sessionId=session-1"),
    );
  });

  it("returns the BTW answer and retries transcript persistence after a session lock", async () => {
    acquireSessionWriteLockMock
      .mockRejectedValueOnce(
        new Error("session file locked (timeout 250ms): pid=123 /tmp/session.lock"),
      )
      .mockResolvedValueOnce({
        release: vi.fn().mockResolvedValue(undefined),
      });
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "323" }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-5",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    const result = await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: "/tmp/agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      question: "What is 17 * 19?",
      sessionEntry: createSessionEntry(),
      resolvedReasoningLevel: "off",
      opts: {},
      isNewSession: false,
    });

    expect(result).toEqual({ text: "323" });
    await vi.waitFor(() => {
      expect(waitForEmbeddedPiRunEndMock).toHaveBeenCalledWith("session-1", 30000);
      expect(appendCustomEntryMock).toHaveBeenCalledWith(
        BTW_CUSTOM_TYPE,
        expect.objectContaining({
          question: "What is 17 * 19?",
          answer: "323",
        }),
      );
    });
  });

  it("logs deferred persistence failures through the diagnostic logger", async () => {
    acquireSessionWriteLockMock
      .mockRejectedValueOnce(
        new Error("session file locked (timeout 250ms): pid=123 /tmp/session.lock"),
      )
      .mockRejectedValueOnce(
        new Error("session file locked (timeout 10000ms): pid=123 /tmp/session.lock"),
      );
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "323" }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-5",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    const result = await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: "/tmp/agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      question: "What is 17 * 19?",
      sessionEntry: createSessionEntry(),
      resolvedReasoningLevel: "off",
      opts: {},
      isNewSession: false,
    });

    expect(result).toEqual({ text: "323" });
    await vi.waitFor(() => {
      expect(diagWarnMock).toHaveBeenCalledWith(
        expect.stringContaining("btw transcript persistence skipped: sessionId=session-1"),
      );
    });
  });

  it("excludes tool results from BTW context to avoid replaying raw tool output", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-1",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "seed" }],
          timestamp: 1,
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "sensitive tool output" }],
          details: { raw: "secret" },
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          timestamp: 3,
        },
      ],
    });
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "323" }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-5",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    await runBtwSideQuestion({
      cfg: {} as never,
      agentDir: "/tmp/agent",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      question: "What is 17 * 19?",
      sessionEntry: createSessionEntry(),
      resolvedReasoningLevel: "off",
      opts: {},
      isNewSession: false,
    });

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      messages: [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({ role: "user" }),
      ],
    });
    expect((context as { messages?: Array<{ role?: string }> }).messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "toolResult" })]),
    );
  });
});
