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

describe("captureSubagentCompletionReply", () => {
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

  it("returns immediate assistant output without polling", async () => {
    readLatestAssistantReplyMock.mockResolvedValueOnce("Immediate assistant completion");

    const result = await captureSubagentCompletionReply("agent:main:subagent:child");

    expect(result).toBe("Immediate assistant completion");
    expect(readLatestAssistantReplyMock).toHaveBeenCalledTimes(1);
    expect(chatHistoryMock).not.toHaveBeenCalled();
  });

  it("polls briefly and returns late tool output once available", async () => {
    vi.useFakeTimers();
    readLatestAssistantReplyMock.mockResolvedValue(undefined);
    chatHistoryMock.mockResolvedValueOnce({ messages: [] }).mockResolvedValueOnce({
      messages: [
        {
          role: "toolResult",
          content: [
            {
              type: "text",
              text: "Late tool result completion",
            },
          ],
        },
      ],
    });

    const pending = captureSubagentCompletionReply("agent:main:subagent:child");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toBe("Late tool result completion");
    expect(chatHistoryMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("returns undefined when no completion output arrives before retry window closes", async () => {
    vi.useFakeTimers();
    readLatestAssistantReplyMock.mockResolvedValue(undefined);
    chatHistoryMock.mockResolvedValue({ messages: [] });

    const pending = captureSubagentCompletionReply("agent:main:subagent:child");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toBeUndefined();
    expect(chatHistoryMock).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
