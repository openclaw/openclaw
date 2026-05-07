import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const piCodingAgentMocks = vi.hoisted(() => ({
  generateSummary: vi.fn(),
  estimateTokens: vi.fn((_message: unknown) => 100),
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  return {
    ...actual,
    generateSummary: piCodingAgentMocks.generateSummary,
    estimateTokens: piCodingAgentMocks.estimateTokens,
  };
});

const { computeAdaptiveChunkRatio, summarizeWithFallback } = await import("./compaction.js");

const testModel = {
  id: "test",
  name: "test",
  contextWindow: 200_000,
  contextTokens: 200_000,
  maxTokens: 8192,
} as unknown as NonNullable<ExtensionContext["model"]>;

describe("summarizeWithFallback", () => {
  beforeEach(() => {
    piCodingAgentMocks.generateSummary.mockReset();
    piCodingAgentMocks.generateSummary.mockRejectedValue(
      new Error("Summarization failed: fetch failed"),
    );
    piCodingAgentMocks.estimateTokens.mockReset();
    piCodingAgentMocks.estimateTokens.mockImplementation(() => 100);
  });

  it("returns the full summary on tier 1 success", async () => {
    piCodingAgentMocks.generateSummary.mockResolvedValueOnce("full summary");

    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "hello",
        timestamp: 1,
      } satisfies UserMessage,
    ];

    const result = await summarizeWithFallback({
      messages,
      model: testModel,
      apiKey: "test-key", // pragma: allowlist secret
      signal: new AbortController().signal,
      reserveTokens: 1000,
      maxChunkTokens: 50_000,
      contextWindow: 200_000,
    });

    expect(result).toBe("full summary");
    expect(piCodingAgentMocks.generateSummary).toHaveBeenCalledTimes(1);
  });

  it("returns a partial tier 2 summary with oversized message placeholders", async () => {
    piCodingAgentMocks.generateSummary
      .mockRejectedValueOnce(new Error("Summarization failed: fetch failed"))
      .mockResolvedValueOnce("partial summary");
    piCodingAgentMocks.estimateTokens.mockImplementation((message: unknown) => {
      const timestamp = (message as { timestamp?: unknown }).timestamp;
      return timestamp === 2 ? 500_000 : 100;
    });

    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "small",
        timestamp: 1,
      } satisfies UserMessage,
      {
        role: "user",
        content: "x".repeat(500_000),
        timestamp: 2,
      } satisfies UserMessage,
    ];

    const result = await summarizeWithFallback({
      messages,
      model: testModel,
      apiKey: "test-key", // pragma: allowlist secret
      signal: new AbortController().signal,
      reserveTokens: 1000,
      maxChunkTokens: 50_000,
      contextWindow: 200_000,
    });

    expect(result).toContain("partial summary");
    expect(result).toContain("[message omitted: oversized — 500000 tokens; role=user]");
    expect(piCodingAgentMocks.generateSummary).toHaveBeenCalledTimes(2);
  });

  it("repairs orphaned tool results before the tier 2 retry", async () => {
    piCodingAgentMocks.generateSummary
      .mockRejectedValueOnce(new Error("Summarization failed: fetch failed"))
      .mockImplementationOnce(async (chunk: AgentMessage[]) => {
        if (chunk.some((message) => message.role === "toolResult")) {
          throw new Error("unexpected tool_use_id");
        }
        return "partial summary without orphaned results";
      });
    piCodingAgentMocks.estimateTokens.mockImplementation((message: unknown) => {
      const timestamp = (message as { timestamp?: unknown }).timestamp;
      return timestamp === 2 ? 500_000 : 100;
    });

    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "small",
        timestamp: 1,
      } satisfies UserMessage,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_oversized", name: "read", input: {} }],
        timestamp: 2,
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "toolu_oversized",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        timestamp: 3,
      } as AgentMessage,
    ];

    const result = await summarizeWithFallback({
      messages,
      model: testModel,
      apiKey: "test-key", // pragma: allowlist secret
      signal: new AbortController().signal,
      reserveTokens: 1000,
      maxChunkTokens: 50_000,
      contextWindow: 200_000,
    });

    expect(result).toContain("partial summary without orphaned results");
    expect(result).not.toContain("unexpected tool_use_id");
    expect(piCodingAgentMocks.generateSummary).toHaveBeenCalledTimes(2);
    expect(piCodingAgentMocks.generateSummary.mock.calls[1][0]).toEqual([messages[0]]);
  });

  it("shrinks the adaptive chunk ratio when average message size exceeds 10% of context", () => {
    piCodingAgentMocks.estimateTokens.mockImplementation(() => 60_000);

    const ratio = computeAdaptiveChunkRatio(
      [
        {
          role: "user",
          content: "large",
          timestamp: 1,
        } satisfies UserMessage,
      ],
      200_000,
    );

    expect(ratio).toBeLessThan(0.4);
    expect(ratio).toBeGreaterThanOrEqual(0.15);
  });

  it("does not duplicate summarization when no messages were oversized", async () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "hello",
        timestamp: 1,
      } satisfies UserMessage,
    ];

    const result = await summarizeWithFallback({
      messages,
      model: testModel,
      apiKey: "test-key", // pragma: allowlist secret
      signal: new AbortController().signal,
      reserveTokens: 1000,
      maxChunkTokens: 50_000,
      contextWindow: 200_000,
    });

    expect(result).toContain("Context contained 1 messages");
    expect(result).toContain("0 oversized");
    // "fetch failed" is timeout-classed now, so summarizeChunks does not retry it.
    expect(piCodingAgentMocks.generateSummary).toHaveBeenCalledTimes(1);
  });

  it("still attempts partial summarization when oversized messages were excluded", async () => {
    piCodingAgentMocks.estimateTokens.mockImplementation((message: unknown) => {
      const content =
        typeof (message as { content?: unknown }).content === "string"
          ? (message as { content: string }).content
          : "";
      return content.length > 10_000 ? 500_000 : 100;
    });

    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "small",
        timestamp: 1,
      } satisfies UserMessage,
      {
        role: "user",
        content: "x".repeat(500_000),
        timestamp: 2,
      } satisfies UserMessage,
    ];

    const result = await summarizeWithFallback({
      messages,
      model: testModel,
      apiKey: "test-key", // pragma: allowlist secret
      signal: new AbortController().signal,
      reserveTokens: 1000,
      maxChunkTokens: 50_000,
      contextWindow: 200_000,
    });

    expect(result).toContain("2 messages (1 oversized)");
    // Full attempt plus distinct partial transcript; timeout-classed failures do not retry.
    expect(piCodingAgentMocks.generateSummary.mock.calls.length).toBe(2);
  });
});
