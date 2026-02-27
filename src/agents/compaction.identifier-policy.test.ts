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

describe("compaction identifier policy", () => {
  const testModel = {
    provider: "anthropic",
    model: "claude-3-opus",
    contextWindow: 200_000,
  } as unknown as NonNullable<ExtensionContext["model"]>;

  beforeEach(() => {
    mockGenerateSummary.mockReset();
    mockGenerateSummary.mockResolvedValue("summary");
  });

  it("defaults to strict identifier preservation", async () => {
    await summarizeInStages({
      messages: [makeMessage(1), makeMessage(2)],
      model: testModel,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 4000,
      maxChunkTokens: 8000,
      contextWindow: 200_000,
    });

    const firstCall = mockGenerateSummary.mock.calls[0];
    expect(firstCall?.[5]).toContain("Preserve all opaque identifiers exactly as written");
    expect(firstCall?.[5]).toContain("UUIDs");
  });

  it("can disable identifier preservation with off policy", async () => {
    await summarizeInStages({
      messages: [makeMessage(1), makeMessage(2)],
      model: testModel,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 4000,
      maxChunkTokens: 8000,
      contextWindow: 200_000,
      summarizationInstructions: { identifierPolicy: "off" },
    });

    const firstCall = mockGenerateSummary.mock.calls[0];
    expect(firstCall?.[5]).toBeUndefined();
  });

  it("supports custom identifier instructions", async () => {
    await summarizeInStages({
      messages: [makeMessage(1), makeMessage(2)],
      model: testModel,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 4000,
      maxChunkTokens: 8000,
      contextWindow: 200_000,
      summarizationInstructions: {
        identifierPolicy: "custom",
        identifierInstructions: "Keep ticket IDs unchanged.",
      },
    });

    const firstCall = mockGenerateSummary.mock.calls[0];
    expect(firstCall?.[5]).toContain("Keep ticket IDs unchanged.");
    expect(firstCall?.[5]).not.toContain("Preserve all opaque identifiers exactly as written");
  });

  it("falls back to strict text when custom policy is missing instructions", () => {
    const built = buildCompactionSummarizationInstructions(undefined, {
      identifierPolicy: "custom",
      identifierInstructions: "   ",
    });
    expect(built).toContain("Preserve all opaque identifiers exactly as written");
  });

  it("avoids duplicate additional-focus headers in split+merge path", async () => {
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
      customInstructions: "Prioritize customer-visible regressions.",
    });

    const mergedCall = mockGenerateSummary.mock.calls.at(-1);
    const instructions = mergedCall?.[5] ?? "";
    expect(instructions).toContain("Merge these partial summaries into a single cohesive summary.");
    expect(instructions).toContain("Prioritize customer-visible regressions.");
    expect((instructions.match(/Additional focus:/g) ?? []).length).toBe(1);
  });
});
