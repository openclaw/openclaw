/**
 * Pins how the safeguard spends a replay budget on mixed-script summaries. The artifact is
 * capped in raw chars by its persistence owner, and a foreground request budget charges it
 * in the estimated chars estimateStringChars() counts, where one CJK character can cost up
 * to CHARS_PER_TOKEN_ESTIMATE * 3. Required facts must be paid for at their own cost, with
 * discardable prose absorbing the cut, and an artifact that overruns the budget must never
 * be accepted whole.
 *
 * Lives beside compaction-safeguard.test.ts, which is grandfathered over the max-lines cap.
 */
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { summarizeInStages } from "../compaction.js";
import { castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import {
  consumeCompactionSafeguardCancellation,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";
import { testing } from "./compaction-safeguard.test-support.js";

const { MAX_COMPACTION_SUMMARY_CHARS } = testing;
/** The replay budget both cases grant: exactly the owner's cap at the ASCII rate. */
const TOKEN_BUDGET = MAX_COMPACTION_SUMMARY_CHARS / CHARS_PER_TOKEN_ESTIMATE;
/** U+3400, a rare BMP ideograph: estimateStringChars() charges it CHARS_PER_TOKEN_ESTIMATE * 3. */
const DENSE_CJK = "\u3400";
/** 1,839 ASCII chars, under the 2,000-char ask bound: affordable at its own cost. */
const REQUIRED_ASK = `confirm the rollout status for ${Array.from(
  { length: 160 },
  (_, index) => `region-${index}`,
).join(", ")}`;

const mockSummarizeInStages = vi.fn<typeof summarizeInStages>();

beforeEach(() => {
  mockSummarizeInStages.mockReset();
  testing.setSummarizeInStagesForTest(mockSummarizeInStages);
});

afterEach(() => {
  testing.setSummarizeInStagesForTest();
});

function stubSessionManager(): ExtensionContext["sessionManager"] {
  const stub: ExtensionContext["sessionManager"] = {
    getCwd: () => "/stub",
    getSessionId: () => "stub-id",
    getSessionTarget: () => undefined,
    getLeafId: () => null,
    getAppendParentId: () => null,
    getAppendMode: () => undefined,
    getLeafEntry: () => undefined,
    getEntry: () => undefined,
    getLabel: () => undefined,
    getBranch: () => [],
    getHeader: () => null,
    getEntries: () => [],
    getTree: () => [],
    getSessionName: () => undefined,
  };
  return stub;
}

/** A 32,000-token window: small enough that no window-derived budget exceeds 16,000. */
const model: Model = {
  id: "sonnet-4.6",
  name: "Sonnet 4.6",
  provider: "anthropic",
  api: "anthropic",
  baseUrl: "https://api.anthropic.com",
  contextWindow: 32_000,
  maxTokens: 8_192,
  reasoning: false,
  input: ["text"],
  cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
};

type CompactionHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
type CompactionOutcome = { cancel?: boolean; compaction?: { summary?: string } };

async function runCompaction(params: {
  qualityGuardEnabled: boolean;
  messageText: string;
  tokenBudget?: number;
}): Promise<{ result: CompactionOutcome; sessionManager: ExtensionContext["sessionManager"] }> {
  let compactionHandler: CompactionHandler | undefined;
  const mockApi = {
    on: vi.fn((event: string, handler: CompactionHandler) => {
      if (event === "session_before_compact") {
        compactionHandler = handler;
      }
    }),
  } as unknown as ExtensionAPI;
  compactionSafeguardExtension(mockApi);
  if (!compactionHandler) {
    throw new Error("Expected compaction safeguard to register a handler.");
  }
  const sessionManager = stubSessionManager();
  setCompactionSafeguardRuntime(sessionManager, {
    model,
    recentTurnsPreserve: 0,
    qualityGuardEnabled: params.qualityGuardEnabled,
    qualityGuardMaxRetries: 0,
  });
  const event = {
    preparation: {
      messagesToSummarize: castAgentMessages([
        { role: "user", content: params.messageText, timestamp: 1 },
      ]),
      turnPrefixMessages: [] as AgentMessage[],
      firstKeptEntryId: "entry-1",
      tokensBefore: 1_500,
      fileOps: { read: [], edited: [], written: [] },
      settings: { reserveTokens: 4_000 },
      isSplitTurn: false,
      summaryTokenBudget: params.tokenBudget ?? TOKEN_BUDGET,
    },
    customInstructions: "",
    signal: new AbortController().signal,
  };
  const ctx = {
    model: undefined,
    sessionManager,
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key" })),
    },
  } as unknown as Partial<ExtensionContext>;
  const result = (await compactionHandler(event, ctx)) as CompactionOutcome;
  return { result, sessionManager };
}

describe("compaction-safeguard mixed-script summary budget", () => {
  it("keeps an affordable ASCII request when dense CJK prose overruns the budget", async () => {
    // The generated prose alone costs 24,000 estimated chars and the summary omits the
    // request, so finalization has to add ~1,850 ASCII chars of required ask context and
    // cut the CJK prose, not price the ASCII at the CJK rate and give up.
    mockSummarizeInStages.mockResolvedValue(
      [
        "## Decisions",
        DENSE_CJK.repeat(2_000),
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Follow rules.",
        "## Pending user asks",
        "None.",
        "## Exact identifiers",
        "None.",
      ].join("\n"),
    );

    const { result, sessionManager } = await runCompaction({
      qualityGuardEnabled: true,
      messageText: REQUIRED_ASK,
    });

    expect(result.cancel).not.toBe(true);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    const summary = result.compaction?.summary ?? "";
    expect(summary).toContain("## Pending user asks\nLatest user request context:");
    expect(summary).toContain(REQUIRED_ASK);
    expect(summary).toContain(DENSE_CJK);
    expect(estimateStringChars(summary)).toBeLessThanOrEqual(
      TOKEN_BUDGET * CHARS_PER_TOKEN_ESTIMATE,
    );
  });

  it("still cancels when the required facts alone overrun the budget", async () => {
    mockSummarizeInStages.mockResolvedValue(
      [
        "## Decisions",
        DENSE_CJK.repeat(2_000),
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Follow rules.",
        "## Pending user asks",
        "None.",
        "## Exact identifiers",
        "None.",
      ].join("\n"),
    );

    // 400 tokens buy 1,600 estimated chars, less than the ask context alone: no
    // candidate may drop it to fit, so the fit fails and history is preserved.
    const { result, sessionManager } = await runCompaction({
      qualityGuardEnabled: true,
      messageText: REQUIRED_ASK,
      tokenBudget: 400,
    });

    expect(result.cancel).toBe(true);
    expect(consumeCompactionSafeguardCancellation(sessionManager)?.reason).toContain(
      "cannot fit beside the foreground prompt",
    );
  });

  it("does not accept a dense CJK summary that overruns the budget by one ideograph", async () => {
    // 1,334 ideographs cost 16,008 estimated chars: 8 over a 16,000 budget, so the whole
    // text must not be treated as fitting.
    const overBudget = DENSE_CJK.repeat(1_334);
    expect(estimateStringChars(overBudget)).toBe(16_008);
    mockSummarizeInStages.mockResolvedValue(overBudget);

    const { result } = await runCompaction({
      qualityGuardEnabled: false,
      messageText: "summarize the migration notes",
    });

    expect(result.cancel).not.toBe(true);
    const summary = result.compaction?.summary ?? "";
    expect(estimateStringChars(summary)).toBeLessThanOrEqual(
      TOKEN_BUDGET * CHARS_PER_TOKEN_ESTIMATE,
    );
    expect(summary).not.toBe(overBudget);
    expect(summary).toContain(DENSE_CJK);
  });
});
