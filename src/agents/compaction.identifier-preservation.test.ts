// Covers identifier-preservation instructions passed to compaction summarization.
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
type SummarizeInput = Parameters<typeof import("./compaction.js").summarizeCompactionHistory>[0];
const testModel = {
  provider: "anthropic",
  model: "claude-3-opus",
  contextWindow: 200_000,
} as unknown as NonNullable<ExtensionContext["model"]>;
const summarizeBase: Omit<SummarizeInput, "messages" | "signal"> = {
  model: testModel,
  apiKey: "test-key", // pragma: allowlist secret
  reserveTokens: 4000,
};

const { summarizeCompactionHistory } = await import("./compaction.js");

function makeMessage(index: number): AgentMessage {
  return { role: "user", content: `m${index}`, timestamp: index };
}

async function runSummary(
  messageCount: number,
  overrides: Partial<Omit<SummarizeInput, "messages" | "signal">> = {},
) {
  return await summarizeCompactionHistory({
    ...summarizeBase,
    ...overrides,
    signal: new AbortController().signal,
    messages: Array.from({ length: messageCount }, (_unused, index) => makeMessage(index + 1)),
  });
}

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
