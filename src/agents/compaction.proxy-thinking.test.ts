import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as piCodingAgent from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeWithFallback } from "./compaction.js";

// Mock generateSummary so we can inspect the model argument it receives.
vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof piCodingAgent>();
  return {
    ...actual,
    generateSummary: vi.fn(),
  };
});

const mockGenerateSummary = vi.mocked(piCodingAgent.generateSummary);

const testMessages: AgentMessage[] = [
  { role: "user", content: "Hello, can you help me?" },
  { role: "assistant", content: "Of course! What do you need?" },
];

function makeModel(
  overrides: Record<string, unknown> = {},
): NonNullable<ExtensionContext["model"]> {
  return {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
    ...overrides,
  } as NonNullable<ExtensionContext["model"]>;
}

describe("compaction proxy thinking normalization (integration)", () => {
  beforeEach(() => {
    mockGenerateSummary.mockClear();
    mockGenerateSummary.mockResolvedValue("Test summary");
  });

  it("passes model with reasoning=true for direct Anthropic endpoint", async () => {
    const model = makeModel({ baseUrl: "https://api.anthropic.com" });

    await summarizeWithFallback({
      messages: testMessages,
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 4000,
      maxChunkTokens: 100000,
      contextWindow: 200000,
    });

    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    const receivedModel = mockGenerateSummary.mock.calls[0][1];
    expect(receivedModel.reasoning).toBe(true);
  });

  it("passes model with reasoning=false for Portkey proxy endpoint", async () => {
    const model = makeModel({ baseUrl: "https://gateway.portkey.ai/v1" });

    await summarizeWithFallback({
      messages: testMessages,
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 4000,
      maxChunkTokens: 100000,
      contextWindow: 200000,
    });

    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    const receivedModel = mockGenerateSummary.mock.calls[0][1];
    expect(receivedModel.reasoning).toBe(false);
  });

  it("passes model with reasoning=false for Vertex AI proxy endpoint", async () => {
    const model = makeModel({
      baseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
    });

    await summarizeWithFallback({
      messages: testMessages,
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 4000,
      maxChunkTokens: 100000,
      contextWindow: 200000,
    });

    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    const receivedModel = mockGenerateSummary.mock.calls[0][1];
    expect(receivedModel.reasoning).toBe(false);
  });

  it("preserves original model id when disabling reasoning", async () => {
    const model = makeModel({ baseUrl: "https://gateway.portkey.ai/v1" });

    await summarizeWithFallback({
      messages: testMessages,
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 4000,
      maxChunkTokens: 100000,
      contextWindow: 200000,
    });

    const receivedModel = mockGenerateSummary.mock.calls[0][1];
    expect(receivedModel.id).toBe("claude-opus-4-6");
    expect(receivedModel.reasoning).toBe(false);
  });

  it("does not modify model for non-anthropic-messages API", async () => {
    const model = makeModel({
      api: "google-vertex",
      baseUrl: "https://some-proxy.example.com",
    });

    await summarizeWithFallback({
      messages: testMessages,
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 4000,
      maxChunkTokens: 100000,
      contextWindow: 200000,
    });

    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    const receivedModel = mockGenerateSummary.mock.calls[0][1];
    expect(receivedModel.reasoning).toBe(true);
  });

  it("normalizes across retry attempts consistently", async () => {
    const model = makeModel({ baseUrl: "https://gateway.portkey.ai/v1" });

    mockGenerateSummary
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("Summary after retry");

    await summarizeWithFallback({
      messages: testMessages,
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 4000,
      maxChunkTokens: 100000,
      contextWindow: 200000,
    });

    expect(mockGenerateSummary).toHaveBeenCalledTimes(2);
    // Both calls should receive the normalized model
    for (const call of mockGenerateSummary.mock.calls) {
      expect(call[1].reasoning).toBe(false);
    }
  });
});
