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

  beforeEach(() => {
    mockGenerateSummary.mockReset();
    mockGenerateSummary.mockResolvedValue("summary");
  });

  it("injects identifier-preservation guidance even without custom instructions", async () => {
    await summarizeInStages({
      messages: [makeMessage(1), makeMessage(2)],
      model: testModel,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 4000,
      maxChunkTokens: 8000,
      contextWindow: 200_000,
    });

    expect(mockGenerateSummary).toHaveBeenCalled();
    const firstCall = mockGenerateSummary.mock.calls[0];
    expect(firstCall?.[5]).toContain("Preserve all opaque identifiers exactly as written");
    expect(firstCall?.[5]).toContain("UUIDs");
    expect(firstCall?.[5]).toContain("IPs");
    expect(firstCall?.[5]).toContain("ports");
  });

  it("keeps identifier-preservation guidance when custom instructions are provided", async () => {
    await summarizeInStages({
      messages: [makeMessage(1), makeMessage(2)],
      model: testModel,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 4000,
      maxChunkTokens: 8000,
      contextWindow: 200_000,
      customInstructions: "Focus on release-impacting bugs.",
    });

    const firstCall = mockGenerateSummary.mock.calls[0];
    expect(firstCall?.[5]).toContain("Preserve all opaque identifiers exactly as written");
    expect(firstCall?.[5]).toContain("Additional focus:");
    expect(firstCall?.[5]).toContain("Focus on release-impacting bugs.");
  });

  it("applies identifier-preservation guidance on staged split + merge summarization", async () => {
    await summarizeInStages({
      messages: [makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4)],
      model: testModel,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 4000,
      maxChunkTokens: 1000,
      contextWindow: 200_000,
      parts: 2,
      minMessagesForSplit: 4,
    });

    expect(mockGenerateSummary.mock.calls.length).toBeGreaterThan(1);
    for (const call of mockGenerateSummary.mock.calls) {
      expect(call[5]).toContain("Preserve all opaque identifiers exactly as written");
    }
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
