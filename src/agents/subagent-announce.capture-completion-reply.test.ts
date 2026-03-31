import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("captureSubagentCompletionReply", () => {
  let previousFastTestEnv: string | undefined;
  let captureSubagentCompletionReply: (typeof import("./subagent-announce.js"))["captureSubagentCompletionReply"];

  async function loadFreshSubagentAnnounceModuleForTest() {
    vi.resetModules();
    ({ captureSubagentCompletionReply } = await import("./subagent-announce.js"));
  }

  beforeAll(async () => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
  });

  afterAll(() => {
    if (previousFastTestEnv === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
  });

  beforeEach(async () => {
    await loadFreshSubagentAnnounceModuleForTest();
    chatHistoryMock.mockReset().mockResolvedValue({ messages: [] });
  });

  it("returns immediate assistant output from history without polling", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Immediate assistant completion" }],
        },
      ],
    });

    const result = await captureSubagentCompletionReply("agent:main:subagent:child");

    expect(result).toBe("Immediate assistant completion");
    expect(chatHistoryMock).toHaveBeenCalledTimes(1);
  });

  it("polls briefly and returns late tool output once available", async () => {
    vi.useFakeTimers();
    chatHistoryMock
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({
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
    expect(chatHistoryMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("returns undefined when no completion output arrives before retry window closes", async () => {
    vi.useFakeTimers();
    chatHistoryMock.mockResolvedValue({ messages: [] });

    const pending = captureSubagentCompletionReply("agent:main:subagent:child");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toBeUndefined();
    expect(chatHistoryMock).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("returns partial assistant progress when the latest assistant turn is tool-only", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Mapped the modules." },
            { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-2", name: "exec", arguments: {} }],
        },
      ],
    });

    const result = await captureSubagentCompletionReply("agent:main:subagent:child");

    expect(result).toBe("Mapped the modules.");
  });

  it("includes exec tool result output alongside final assistant summary", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "exec",
              arguments: { command: "wc -c file.json" },
            },
          ],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "123 file.json" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "The file has 123 bytes." }],
        },
      ],
    });

    const result = await captureSubagentCompletionReply("agent:main:subagent:child");

    expect(result).toContain("123 file.json");
    expect(result).toContain("The file has 123 bytes.");
  });

  it("resets tool results after intermediate assistant summary", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "first command output" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "First round done." }],
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-2", name: "exec", arguments: {} }],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "second command output" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "All done." }],
        },
      ],
    });

    const result = await captureSubagentCompletionReply("agent:main:subagent:child");

    // First round output was absorbed by "First round done." and should not reappear
    expect(result).not.toContain("first command output");
    expect(result).toContain("second command output");
    expect(result).toContain("All done.");
  });

  it("includes multiple tool results from the same final round", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "exec", arguments: {} },
            { type: "toolCall", id: "call-2", name: "exec", arguments: {} },
          ],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "output A" }],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "output B" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Final summary." }],
        },
      ],
    });

    const result = await captureSubagentCompletionReply("agent:main:subagent:child");

    expect(result).toContain("output A");
    expect(result).toContain("output B");
    expect(result).toContain("Final summary.");
  });

  it("extracts tool result from nested content object", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "toolResult",
          content: {
            content: [{ type: "text", text: "nested tool output" }],
            details: { status: "completed" },
          },
        },
      ],
    });

    const result = await captureSubagentCompletionReply("agent:main:subagent:child");

    expect(result).toBe("nested tool output");
  });
});
