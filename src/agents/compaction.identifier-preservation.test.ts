import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as piCodingAgent from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCompactionSummarizationInstructions, summarizeInStages } from "./compaction.js";

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof piCodingAgent>();
  return {
    ...actual,
    generateSummary: vi.fn(),
  };
});

const mockGenerateSummary = vi.mocked(piCodingAgent.generateSummary);
type SummarizeInStagesInput = Parameters<typeof summarizeInStages>[0];

function makeMessage(index: number, size = 1200): AgentMessage {
  return {
    role: "user",
    content: `m${index}-${"x".repeat(size)}`,
    timestamp: index,
  };
}

describe("compaction identifier-preservation instructions", () => {
  const testModel = {
    provider: "anthropic",
    model: "claude-3-opus",
    contextWindow: 200_000,
  } as unknown as NonNullable<ExtensionContext["model"]>;
  const summarizeBase: Omit<SummarizeInStagesInput, "messages"> = {
    model: testModel,
    apiKey: "test-key",
    reserveTokens: 4000,
    maxChunkTokens: 8000,
    contextWindow: 200_000,
    signal: new AbortController().signal,
  };

  beforeEach(() => {
    mockGenerateSummary.mockReset();
    mockGenerateSummary.mockResolvedValue("summary");
  });

  async function runSummary(
    messageCount: number,
    overrides: Partial<Omit<SummarizeInStagesInput, "messages">> = {},
  ) {
    await summarizeInStages({
      ...summarizeBase,
      ...overrides,
      signal: new AbortController().signal,
      messages: Array.from({ length: messageCount }, (_unused, index) => makeMessage(index + 1)),
    });
  }

  function firstSummaryInstructions() {
    return mockGenerateSummary.mock.calls[0]?.[5];
  }

  it("injects identifier-preservation guidance even without custom instructions", async () => {
    await runSummary(2);

    expect(mockGenerateSummary).toHaveBeenCalled();
    expect(firstSummaryInstructions()).toContain(
      "Preserve all opaque identifiers exactly as written",
    );
    expect(firstSummaryInstructions()).toContain("UUIDs");
    expect(firstSummaryInstructions()).toContain("IPs");
    expect(firstSummaryInstructions()).toContain("ports");
  });

  it("keeps identifier-preservation guidance when custom instructions are provided", async () => {
    await runSummary(2, {
      customInstructions: "Focus on release-impacting bugs.",
    });

    expect(firstSummaryInstructions()).toContain(
      "Preserve all opaque identifiers exactly as written",
    );
    expect(firstSummaryInstructions()).toContain("Additional focus:");
    expect(firstSummaryInstructions()).toContain("Focus on release-impacting bugs.");
  });

  it("applies identifier-preservation guidance on staged split + merge summarization", async () => {
    await runSummary(4, {
      maxChunkTokens: 1000,
      parts: 2,
      minMessagesForSplit: 4,
    });

    expect(mockGenerateSummary.mock.calls.length).toBeGreaterThan(1);
    for (const call of mockGenerateSummary.mock.calls) {
      expect(call[5]).toContain("Preserve all opaque identifiers exactly as written");
    }
  });

  it("avoids duplicate additional-focus headers in split+merge path", async () => {
    await runSummary(4, {
      maxChunkTokens: 1000,
      parts: 2,
      minMessagesForSplit: 4,
      customInstructions: "Prioritize customer-visible regressions.",
    });

    const mergedCall = mockGenerateSummary.mock.calls.at(-1);
    const instructions = mergedCall?.[5] ?? "";
    expect(instructions).toContain("Merge these partial summaries into a single cohesive summary.");
    expect(instructions).toContain("Prioritize customer-visible regressions.");
    expect((instructions.match(/Additional focus:/g) ?? []).length).toBe(1);
  });
});

describe("buildCompactionSummarizationInstructions", () => {
  it("returns base instructions when no custom text is provided", () => {
    const result = buildCompactionSummarizationInstructions();
    expect(result).toContain("Preserve all opaque identifiers exactly as written");
    expect(result).not.toContain("Additional focus:");
  });

  it("appends custom instructions in a stable format", () => {
    const result = buildCompactionSummarizationInstructions("Keep deployment details.");
    expect(result).toContain("Preserve all opaque identifiers exactly as written");
    expect(result).toContain("Additional focus:");
    expect(result).toContain("Keep deployment details.");
  });
});
