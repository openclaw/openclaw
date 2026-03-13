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
    expect(onBlockReply).toHaveBeenCalledWith({ text: "Side answer." });
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
    expect(waitForEmbeddedPiRunEndMock).toHaveBeenCalledWith("session-1", 30000);
    await vi.waitFor(() => {
      expect(appendCustomEntryMock).toHaveBeenCalledWith(
        BTW_CUSTOM_TYPE,
        expect.objectContaining({
          question: "What is 17 * 19?",
          answer: "323",
        }),
      );
    });
  });
});
