import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetUsagePreflightCacheForTests,
  evaluateUsagePreflight,
  usagePreflightDecisionMessage,
} from "./usage-preflight.js";

const loadProviderUsageSummaryMock = vi.fn();
const resolveUsageProviderIdMock = vi.fn((provider?: string | null) => {
  if (provider === "openai-codex") {
    return "openai-codex";
  }
  return undefined;
});

vi.mock("../../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: (...args: unknown[]) => loadProviderUsageSummaryMock(...args),
  resolveUsageProviderId: (provider?: string | null) => resolveUsageProviderIdMock(provider),
}));

const emptyHistory: AgentMessage[] = [];

describe("usage preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetUsagePreflightCacheForTests();
  });

  it("hard-blocks when remaining usage is <= 1%", async () => {
    loadProviderUsageSummaryMock.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai-codex",
          displayName: "Codex",
          windows: [{ label: "3h", usedPercent: 99 }],
        },
      ],
    });

    const decision = await evaluateUsagePreflight({
      provider: "openai-codex",
      prompt: "short",
      historyMessages: emptyHistory,
    });

    expect(decision.blocked).toBe(true);
    expect(decision.warning).toBe(true);
    expect(decision.remainingPercent).toBe(1);
  });

  it("blocks when remaining usage is <= 2% for non-trivial prompt size", async () => {
    loadProviderUsageSummaryMock.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai-codex",
          displayName: "Codex",
          windows: [{ label: "day", usedPercent: 98 }],
        },
      ],
    });

    const decision = await evaluateUsagePreflight({
      provider: "openai-codex",
      prompt: "x".repeat(1_200),
      historyMessages: emptyHistory,
    });

    expect(decision.estimatedPromptTokens).toBeGreaterThanOrEqual(256);
    expect(decision.blocked).toBe(true);
    expect(decision.warning).toBe(true);
  });

  it("warns without blocking when near limit but prompt estimate is small", async () => {
    loadProviderUsageSummaryMock.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai-codex",
          displayName: "Codex",
          windows: [{ label: "day", usedPercent: 98 }],
        },
      ],
    });

    const decision = await evaluateUsagePreflight({
      provider: "openai-codex",
      prompt: "tiny",
      historyMessages: emptyHistory,
    });

    expect(decision.blocked).toBe(false);
    expect(decision.warning).toBe(true);
    expect(decision.remainingPercent).toBe(2);
  });

  it("fails open when provider usage data is unavailable", async () => {
    loadProviderUsageSummaryMock.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [],
    });

    const decision = await evaluateUsagePreflight({
      provider: "openai-codex",
      prompt: "hello",
      historyMessages: emptyHistory,
    });

    expect(decision.blocked).toBe(false);
    expect(decision.warning).toBe(false);
  });

  it("formats a user-facing block message", () => {
    const message = usagePreflightDecisionMessage(
      {
        providerId: "openai-codex",
        blocked: true,
        warning: true,
        estimatedPromptTokens: 512,
        remainingPercent: 1,
        windowLabel: "3h",
        resetAt: Date.now() + 30 * 60 * 1000,
      },
      Date.now(),
    );

    expect(message).toContain("Usage guard");
    expect(message).toContain("openai-codex");
  });
});
