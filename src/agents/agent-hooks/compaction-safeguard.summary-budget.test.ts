import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { summarizeCompactionHistory } from "../compaction.js";
import { consumeCompactionSafeguardCancellation } from "./compaction-safeguard-runtime.js";
import {
  createCompactionEvent,
  createQualityGuardSessionManager,
  expectCompactionResult,
  runCompactionScenario,
  structuredSummary,
  testing,
} from "./compaction-safeguard.test-support.js";

const { MAX_COMPACTION_SUMMARY_CHARS, resolveSplitTurnContextChars } = testing;
const CJK_PROSE = "迁移记录需要保留已确认的部署决策与运行状态。";
const REQUIRED_ASK = `confirm the rollout status for ${Array.from(
  { length: 160 },
  (_, index) => `region-${index}`,
).join(", ")}`;
const mockSummarizeCompactionHistory = vi.fn<typeof summarizeCompactionHistory>();

beforeEach(() => {
  mockSummarizeCompactionHistory.mockReset();
  mockSummarizeCompactionHistory.mockResolvedValue(
    structuredSummary({ decisions: CJK_PROSE.repeat(100) }),
  );
  testing.setSummarizeCompactionHistoryForTest(mockSummarizeCompactionHistory);
});

afterEach(() => {
  testing.setSummarizeCompactionHistoryForTest();
});

describe("compaction-safeguard mixed-script summary budget", () => {
  it("trims CJK prose while preserving an affordable ASCII request", async () => {
    const tokenBudget = 1_000;
    const sessionManager = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 });
    const event = createCompactionEvent({
      messageText: REQUIRED_ASK,
      preparation: { summaryTokenBudget: tokenBudget },
    });

    const { result } = await runCompactionScenario(sessionManager, event);

    const { summary } = expectCompactionResult(result);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    expect(summary).toContain("## Pending user asks\nLatest user request context:");
    expect(summary).toContain(REQUIRED_ASK);
    expect(summary).toContain(CJK_PROSE);
    expect(estimateStringChars(summary)).toBeLessThanOrEqual(
      tokenBudget * CHARS_PER_TOKEN_ESTIMATE,
    );
  });

  it("marks a bounded degraded summary when required facts exceed the token budget", async () => {
    const sessionManager = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 });
    const event = createCompactionEvent({
      messageText: REQUIRED_ASK,
      preparation: { summaryTokenBudget: 400 },
    });

    const { result } = await runCompactionScenario(sessionManager, event);

    expect(result).toMatchObject({ compaction: { details: { qualityDegraded: true } } });
    const { summary } = expectCompactionResult(result);
    expect(estimateStringChars(summary)).toBeLessThanOrEqual(400 * CHARS_PER_TOKEN_ESTIMATE);
    expect(summary).not.toContain(REQUIRED_ASK);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("drops an oversized identifier so the artifact can still be committed", async () => {
    const latestAsk = "preserve the pending deployment status";
    const identifier = `https://example.com/${"a".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`;
    const oversizedRequiredTail = structuredSummary({ asks: latestAsk, identifiers: identifier });
    mockSummarizeCompactionHistory.mockResolvedValue(oversizedRequiredTail);

    const sessionManager = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 });
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
    });

    const { result } = await runCompactionScenario(sessionManager, event);

    expect(result).toMatchObject({ compaction: { details: { qualityDegraded: true } } });
    const { summary } = expectCompactionResult(result);
    expect(summary).toContain(latestAsk);
    expect(summary).not.toContain(identifier);
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(mockSummarizeCompactionHistory).toHaveBeenCalledTimes(1);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it.each([48_000, 64_000])("keeps a long summary under the configured %s cap", async (maxChars) => {
    mockSummarizeCompactionHistory.mockResolvedValue(structuredSummary({ decisions: "d".repeat(30_000) }));
    const sessionManager = createQualityGuardSessionManager({
      qualityGuardMaxRetries: 0,
      maxSummaryChars: maxChars,
    });
    const event = createCompactionEvent({ messageText: "summarize me" });

    const { result } = await runCompactionScenario(sessionManager, event);

    const { summary } = expectCompactionResult(result);
    expect(summary.length).toBeGreaterThan(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary.length).toBeLessThanOrEqual(maxChars);
    expect(summary).toContain("d".repeat(100));
  });

  it("derives the split-turn budget from the configured cap", () => {
    expect(resolveSplitTurnContextChars(16_000)).toBe(8_000);
    expect(resolveSplitTurnContextChars(48_000)).toBe(24_000);
    expect(resolveSplitTurnContextChars(64_000)).toBe(32_000);
  });
});
