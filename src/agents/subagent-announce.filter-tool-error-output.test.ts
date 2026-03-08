import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readLatestAssistantReplyMock = vi.fn<(sessionKey: string) => Promise<string | undefined>>(
  async (_sessionKey: string) => undefined,
);
const chatHistoryMock = vi.fn<(sessionKey: string) => Promise<{ messages?: Array<unknown> }>>(
  async (_sessionKey: string) => ({ messages: [] }),
);

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: unknown) => {
    const typed = request as { method?: string; params?: { sessionKey?: string } };
    if (typed.method === "chat.history") {
      return await chatHistoryMock(typed.params?.sessionKey ?? "");
    }
    return {};
  }),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: readLatestAssistantReplyMock,
}));

describe("captureSubagentCompletionReply - tool error filtering (#39032)", () => {
  let previousFastTestEnv: string | undefined;
  let captureSubagentCompletionReply: (typeof import("./subagent-announce.js"))["captureSubagentCompletionReply"];

  beforeAll(async () => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    ({ captureSubagentCompletionReply } = await import("./subagent-announce.js"));
  });

  afterAll(() => {
    if (previousFastTestEnv === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
  });

  beforeEach(() => {
    readLatestAssistantReplyMock.mockReset().mockResolvedValue(undefined);
    chatHistoryMock.mockReset().mockResolvedValue({ messages: [] });
  });

  it("skips error tool results so internal failure text does not leak to parent", async () => {
    vi.useFakeTimers();
    readLatestAssistantReplyMock.mockResolvedValue(undefined);
    chatHistoryMock.mockResolvedValueOnce({ messages: [] }).mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Task completed successfully." }],
        },
        {
          role: "toolResult",
          is_error: true,
          content: [
            {
              type: "text",
              text: "The message tool needs a Telegram chat ID, not a session key. agent:main:main is not a valid chat ID.",
            },
          ],
        },
      ],
    });

    const pending = captureSubagentCompletionReply("agent:main:subagent:child");
    await vi.runAllTimersAsync();
    const result = await pending;

    // Should return the assistant text, NOT the error tool result
    expect(result).toBe("Task completed successfully.");
    vi.useRealTimers();
  });

  it("skips error tool results with isError field (camelCase variant)", async () => {
    vi.useFakeTimers();
    readLatestAssistantReplyMock.mockResolvedValue(undefined);
    chatHistoryMock.mockResolvedValueOnce({ messages: [] }).mockResolvedValueOnce({
      messages: [
        {
          role: "toolResult",
          isError: true,
          content: "Error: invalid session key format",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Final answer here." }],
        },
      ],
    });

    const pending = captureSubagentCompletionReply("agent:main:subagent:child");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toBe("Final answer here.");
    vi.useRealTimers();
  });

  it("still returns successful tool results as output", async () => {
    vi.useFakeTimers();
    readLatestAssistantReplyMock.mockResolvedValue(undefined);
    chatHistoryMock.mockResolvedValueOnce({ messages: [] }).mockResolvedValueOnce({
      messages: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "Successful tool output" }],
        },
      ],
    });

    const pending = captureSubagentCompletionReply("agent:main:subagent:child");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toBe("Successful tool output");
    vi.useRealTimers();
  });

  it("returns undefined when only error tool results exist and no assistant message", async () => {
    vi.useFakeTimers();
    readLatestAssistantReplyMock.mockResolvedValue(undefined);
    chatHistoryMock.mockResolvedValue({
      messages: [
        {
          role: "toolResult",
          is_error: true,
          content: "Internal error: session key is not a valid Telegram chat ID",
        },
      ],
    });

    const pending = captureSubagentCompletionReply("agent:main:subagent:child");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toBeUndefined();
    vi.useRealTimers();
  });
});
