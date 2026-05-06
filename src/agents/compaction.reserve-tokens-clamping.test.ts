import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const piCodingAgentMocks = vi.hoisted(() => ({
  estimateTokens: vi.fn((message: unknown) => Math.ceil(JSON.stringify(message).length / 4)),
  generateSummary: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  return {
    ...actual,
    estimateTokens: piCodingAgentMocks.estimateTokens,
    generateSummary: piCodingAgentMocks.generateSummary,
  };
});

const mockGenerateSummary = piCodingAgentMocks.generateSummary;

let summarizeInStages: typeof import("./compaction.js").summarizeInStages;

async function loadFreshCompactionModuleForTest() {
  vi.resetModules();
  ({ summarizeInStages } = await import("./compaction.js"));
}

function makeMessage(index: number, size = 1200): AgentMessage {
  return {
    role: "user",
    content: `m${index}-${"x".repeat(size)}`,
    timestamp: index,
  };
}

describe("compaction reserveTokens clamping", () => {
  beforeEach(async () => {
    await loadFreshCompactionModuleForTest();
    mockGenerateSummary.mockReset();
    mockGenerateSummary.mockResolvedValue("summary");
    piCodingAgentMocks.estimateTokens.mockReset();
    piCodingAgentMocks.estimateTokens.mockImplementation((message: unknown) =>
      Math.ceil(JSON.stringify(message).length / 4),
    );
  });

  it("clamps reserveTokens when model maxTokens is smaller than requested", async () => {
    // Simulate the exact bug scenario: large context window (1M) with
    // reserveTokensFloor of 300K, but model output limit is only 128K.
    // Without clamping, generateSummary would receive 300K and compute
    // max_tokens = floor(0.8 * 300K) = 240K, exceeding the 128K model limit.
    const model = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    } as unknown as NonNullable<ExtensionContext["model"]>;

    await summarizeInStages({
      model,
      apiKey: "test-key", // pragma: allowlist secret
      reserveTokens: 300_000,
      maxChunkTokens: 8000,
      contextWindow: 1_000_000,
      signal: new AbortController().signal,
      messages: [makeMessage(1), makeMessage(2)],
    });

    expect(mockGenerateSummary).toHaveBeenCalled();
    // Third argument to generateSummary is reserveTokens.
    // With maxTokens 128K, the clamp should be floor(128_000 / 0.8) = 160_000.
    const passedReserveTokens = mockGenerateSummary.mock.calls[0][2];
    expect(passedReserveTokens).toBeLessThanOrEqual(Math.floor(128_000 / 0.8));
    expect(passedReserveTokens).toBe(160_000);
  });

  it("does not clamp when model maxTokens is large enough", async () => {
    const model = {
      provider: "anthropic",
      model: "claude-opus-4-6",
      contextWindow: 200_000,
      maxTokens: 32_000,
    } as unknown as NonNullable<ExtensionContext["model"]>;

    // reserveTokens 4000 is well under floor(32_000 / 0.8) = 40_000
    await summarizeInStages({
      model,
      apiKey: "test-key", // pragma: allowlist secret
      reserveTokens: 4000,
      maxChunkTokens: 8000,
      contextWindow: 200_000,
      signal: new AbortController().signal,
      messages: [makeMessage(1), makeMessage(2)],
    });

    expect(mockGenerateSummary).toHaveBeenCalled();
    const passedReserveTokens = mockGenerateSummary.mock.calls[0][2];
    expect(passedReserveTokens).toBe(4000);
  });

  it("falls back to 128K default when model has no maxTokens field", async () => {
    // Model without maxTokens defined — should default to 128_000 as the cap.
    const model = {
      provider: "anthropic",
      model: "claude-3-opus",
      contextWindow: 1_000_000,
    } as unknown as NonNullable<ExtensionContext["model"]>;

    await summarizeInStages({
      model,
      apiKey: "test-key", // pragma: allowlist secret
      reserveTokens: 300_000,
      maxChunkTokens: 8000,
      contextWindow: 1_000_000,
      signal: new AbortController().signal,
      messages: [makeMessage(1), makeMessage(2)],
    });

    expect(mockGenerateSummary).toHaveBeenCalled();
    // Fallback maxTokens is 128_000, so clamp = floor(128_000 / 0.8) = 160_000
    const passedReserveTokens = mockGenerateSummary.mock.calls[0][2];
    expect(passedReserveTokens).toBe(160_000);
  });

  it("clamps consistently across all chunks in staged summarization", async () => {
    const model = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    } as unknown as NonNullable<ExtensionContext["model"]>;

    // Use enough messages and small chunk size to force multiple chunks
    await summarizeInStages({
      model,
      apiKey: "test-key", // pragma: allowlist secret
      reserveTokens: 300_000,
      maxChunkTokens: 1000,
      contextWindow: 1_000_000,
      signal: new AbortController().signal,
      messages: Array.from({ length: 4 }, (_, i) => makeMessage(i + 1)),
      parts: 2,
      minMessagesForSplit: 4,
    });

    expect(mockGenerateSummary.mock.calls.length).toBeGreaterThan(1);
    const expectedClamp = Math.floor(128_000 / 0.8);
    for (const call of mockGenerateSummary.mock.calls) {
      expect(call[2]).toBeLessThanOrEqual(expectedClamp);
    }
  });
});
