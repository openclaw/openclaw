// Covers identifier-preservation instructions through single and staged
// compaction summarization paths.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as agentSessions from "./sessions/index.js";

vi.mock("./sessions/index.js", async () => {
  const actual = await vi.importActual<typeof agentSessions>("./sessions/index.js");
  return {
    ...actual,
    generateSummary: vi.fn(),
  };
});

const mockGenerateSummary = vi.mocked(agentSessions.generateSummary);
type SummarizeInStagesInput = Parameters<typeof import("./compaction.js").summarizeInStages>[0];
const MESSAGE_TIME_BASE_MS = Date.UTC(2026, 0, 1);
const testModel = {
  provider: "anthropic",
  model: "claude-3-opus",
  contextWindow: 200_000,
} as unknown as NonNullable<ExtensionContext["model"]>;
const summarizeBase: Omit<SummarizeInStagesInput, "messages"> = {
  model: testModel,
  apiKey: "test-key", // pragma: allowlist secret
  reserveTokens: 4000,
  maxChunkTokens: 8000,
  contextWindow: 200_000,
  signal: new AbortController().signal,
};

const { summarizeInStages } = await import("./compaction.js");

function makeMessage(index: number, size = 1200): AgentMessage {
  return {
    role: "user",
    content: `m${index}-${"x".repeat(size)}`,
    timestamp: MESSAGE_TIME_BASE_MS + index * 60_000,
  };
}

async function runSummary(
  messageCount: number,
  overrides: Partial<Omit<SummarizeInStagesInput, "messages">> = {},
) {
  // Each run gets a fresh AbortSignal because summarizeInStages treats the
  // signal as a per-request lifecycle boundary.
  return await summarizeInStages({
    ...summarizeBase,
    ...overrides,
    signal: new AbortController().signal,
    messages: Array.from({ length: messageCount }, (_unused, index) => makeMessage(index + 1)),
  });
}

describe("compaction identifier-preservation instructions", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
    mockGenerateSummary.mockResolvedValue("summary");
  });

  it("avoids duplicate additional-focus headers in split+merge path", async () => {
    await runSummary(4, {
      maxChunkTokens: 1000,
      parts: 2,
      minMessagesForSplit: 4,
      customInstructions: "Prioritize customer-visible regressions.",
    });

    expect(mockGenerateSummary).toHaveBeenCalledTimes(3);
    for (const call of mockGenerateSummary.mock.calls) {
      expect(call[6]).toContain("Preserve all opaque identifiers exactly as written");
    }
    const mergeMessages = mockGenerateSummary.mock.calls[2]![0];
    expect(mergeMessages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "[Chunk 1 — oldest messages [2026-01-01 00:01 — 2026-01-01 00:02 UTC]]\nsummary",
      }),
      expect.objectContaining({
        role: "user",
        content:
          "[Chunk 2 — most recent messages [2026-01-01 00:03 — 2026-01-01 00:04 UTC]]\nsummary",
      }),
    ]);
    const firstTimestamp = mergeMessages[0]?.timestamp;
    if (typeof firstTimestamp !== "number") {
      throw new Error("expected a numeric merge-message timestamp");
    }
    expect(mergeMessages[1]?.timestamp).toBe(firstTimestamp + 1);
    const instructions = mockGenerateSummary.mock.calls.at(-1)?.[6] ?? "";
    expect(instructions).toContain("Merge these partial summaries into a single cohesive summary.");
    expect(instructions).toContain("Prioritize customer-visible regressions.");
    expect((instructions.match(/Additional focus:/g) ?? []).length).toBe(1);
  });
});

describe("compaction identifier policy", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
    mockGenerateSummary.mockResolvedValue("summary");
  });

  it("falls back to strict text when custom policy is missing instructions", async () => {
    await runSummary(2, {
      summarizationInstructions: {
        identifierPolicy: "custom",
        identifierInstructions: "   ",
      },
    });
    expect(mockGenerateSummary).toHaveBeenCalledOnce();
    expect(mockGenerateSummary.mock.calls[0]?.[6]).toContain(
      "Preserve all opaque identifiers exactly as written",
    );
  });

  it("keeps custom focus text when identifier policy is off", async () => {
    await runSummary(2, {
      customInstructions: "Track release blockers.",
      summarizationInstructions: { identifierPolicy: "off" },
    });

    expect(mockGenerateSummary).toHaveBeenCalledOnce();
    expect(mockGenerateSummary.mock.calls[0]?.[6]).toBe(
      "Additional focus:\nTrack release blockers.",
    );
  });
});

describe("compaction staged summarization failures", () => {
  const runStagedSummary = () =>
    runSummary(6, {
      maxChunkTokens: 1000,
      parts: 3,
      minMessagesForSplit: 2,
    });

  beforeEach(() => {
    mockGenerateSummary.mockReset();
  });

  it("completes the merge successfully when all chunks succeed", async () => {
    mockGenerateSummary
      .mockResolvedValueOnce("summary of chunk 1")
      .mockResolvedValueOnce("summary of chunk 2")
      .mockResolvedValueOnce("summary of chunk 3")
      .mockResolvedValue("merged: chunk 1 + chunk 2 + chunk 3");

    await expect(runStagedSummary()).resolves.toEqual(expect.stringContaining("merged"));
  });

  it("throws CompactionError when a later chunk fails after earlier successes", async () => {
    mockGenerateSummary
      .mockResolvedValueOnce("summary of chunk 1")
      .mockRejectedValue(new Error("fetch failed on chunk 2"));

    await expect(runStagedSummary()).rejects.toThrow();
  });
});
