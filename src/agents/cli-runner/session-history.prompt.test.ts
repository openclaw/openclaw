// Covers CLI session reseed prompt rendering and its history-cap boundaries.
import { describe, expect, it } from "vitest";
import {
  buildCliSessionHistoryPrompt,
  resolveAutoCliSessionReseedHistoryChars,
} from "./session-history.js";

const MAX_CLI_SESSION_RESEED_HISTORY_CHARS = 12 * 1024;
const MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS = 256 * 1024;
const RESEED_CURRENCY_GUIDANCE =
  "[Recovered history may be stale; verify current and time-sensitive facts before acting.]";

function withReseedGuidanceBudget(historyChars: number): number {
  return RESEED_CURRENCY_GUIDANCE.length + "\n".length + historyChars;
}

function extractReseedHistory(prompt: string | undefined): string {
  return prompt?.match(/<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/)?.[1] ?? "";
}

describe("buildCliSessionHistoryPrompt", () => {
  it("renders OpenClaw transcript history around the next user message", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "old ask" },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      ],
      prompt: "new ask",
    });

    expect(prompt).toContain("User: old ask");
    expect(prompt).toContain("Assistant: old answer");
    expect(prompt).toContain("<next_user_message>\nnew ask\n</next_user_message>");
  });

  it("renders canonical saved timestamps and omits invalid or noncanonical timestamps", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "dated ask", timestamp: "2026-06-17T16:00:00.000Z" },
        { role: "assistant", content: "zero date answer", timestamp: "0" },
        { role: "user", content: "year-only ask", timestamp: "2026" },
        { role: "assistant", content: "invalid date answer", timestamp: "not-a-date" },
        { role: "user", content: "offset date ask", timestamp: "2026-06-17T12:00:00-04:00" },
        { role: "assistant", content: "undated answer" },
      ],
      prompt: "new ask",
    });

    expect(prompt).toContain("[2026-06-17T16:00:00.000Z] User: dated ask");
    expect(prompt).toMatch(
      /Assistant: zero date answer[\s\S]*User: year-only ask[\s\S]*Assistant: invalid date answer[\s\S]*User: offset date ask[\s\S]*Assistant: undated answer/u,
    );
    expect(prompt).not.toMatch(
      /\[(?:2000-01-01T00:00:00\.000Z|2026-01-01T00:00:00\.000Z|not-a-date|2026-06-17T12:00:00-04:00)\]/u,
    );
    expect(prompt).toContain(RESEED_CURRENCY_GUIDANCE);
  });

  it("skips reseed text when the transcript has no renderable conversation", () => {
    expect(
      buildCliSessionHistoryPrompt({
        messages: [{ role: "tool", content: "ignored" }],
        prompt: "new ask",
      }),
    ).toBeUndefined();
  });

  it("caps rendered reseed history before adding the next user message", () => {
    const maxHistoryChars = withReseedGuidanceBudget(80);
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "x".repeat(100) },
        { role: "assistant", content: "y".repeat(100) },
      ],
      prompt: "current ask must survive",
      maxHistoryChars,
    });

    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    expect(prompt).toContain("<next_user_message>\ncurrent ask must survive\n</next_user_message>");
    // Older 100-char prefix must be dropped by the tail slice; the
    // post-cap rendered tail is shorter than the dropped prefix.
    expect(prompt).not.toContain("x".repeat(80));
    expect(extractReseedHistory(prompt).length).toBeLessThanOrEqual(maxHistoryChars);
  });

  it("keeps a whole code point when the retained history tail starts inside an emoji", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [{ role: "user", content: "prefix😀tail" }],
      prompt: "next",
      maxHistoryChars: withReseedGuidanceBudget(5),
    });

    expect(prompt).toContain(
      `<conversation_history>\n${RESEED_CURRENCY_GUIDANCE}\ntail\n</conversation_history>`,
    );
  });

  it("scales automatic reseed history caps from Claude context tiers", () => {
    expect(resolveAutoCliSessionReseedHistoryChars(0)).toBe(MAX_CLI_SESSION_RESEED_HISTORY_CHARS);
    expect(resolveAutoCliSessionReseedHistoryChars(32_000)).toBe(
      MAX_CLI_SESSION_RESEED_HISTORY_CHARS,
    );
    expect(resolveAutoCliSessionReseedHistoryChars(200_000)).toBe(64_000);
    expect(resolveAutoCliSessionReseedHistoryChars(1_048_576)).toBe(
      MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS,
    );
  });

  it("keeps the most recent turns when rendered history exceeds the cap", () => {
    // Older turns plus a final marker turn whose content is exactly what a
    // head-slice would drop first. Asserting the marker survives in the
    // rendered prompt locks in tail-slice semantics: a session-recovery
    // feature must keep the latest context, not the oldest.
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "x".repeat(8000) },
        { role: "assistant", content: "y".repeat(8000) },
        { role: "user", content: "FINAL_USER_MARKER" },
        { role: "assistant", content: "FINAL_ASSISTANT_MARKER" },
      ],
      prompt: "next ask",
    });

    expect(prompt).toBeDefined();
    expect(prompt).toContain("FINAL_USER_MARKER");
    expect(prompt).toContain("FINAL_ASSISTANT_MARKER");
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // The oldest 8000-char block must have been dropped — a head-slice
    // would have kept it instead of the recent tail.
    expect(prompt).not.toContain("x".repeat(8000));
    expect(prompt).toContain("<next_user_message>\nnext ask\n</next_user_message>");
  });

  it("preserves the compaction summary when the post-summary transcript exceeds the cap", () => {
    // loadCliSessionReseedMessages places a compactionSummary entry first
    // so the compacted prior context survives reseed. A blind tail slice
    // of the joined history would drop that summary whenever the
    // post-summary tail alone exceeds the cap. The structure-aware
    // truncation pins the summary as a prefix and caps only the tail.
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: "COMPACTION_SUMMARY_MARKER pinned context" },
        { role: "user", content: "z".repeat(8000) },
        { role: "assistant", content: "w".repeat(8000) },
        { role: "user", content: "POST_SUMMARY_FINAL_USER" },
        { role: "assistant", content: "POST_SUMMARY_FINAL_ASSISTANT" },
      ],
      prompt: "next ask",
    });

    expect(prompt).toBeDefined();
    // Compaction summary must be pinned as a prefix, not sliced away.
    expect(prompt).toContain("Compaction summary: COMPACTION_SUMMARY_MARKER pinned context");
    // Recent tail still preserved within the post-summary budget.
    expect(prompt).toContain("POST_SUMMARY_FINAL_USER");
    expect(prompt).toContain("POST_SUMMARY_FINAL_ASSISTANT");
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // Head of post-summary tail (oldest 8000-char `z` block) must be
    // dropped so the cap is honored.
    expect(prompt).not.toContain("z".repeat(8000));
    expect(prompt).toContain("<next_user_message>\nnext ask\n</next_user_message>");
    expect(extractReseedHistory(prompt).length).toBeLessThanOrEqual(
      MAX_CLI_SESSION_RESEED_HISTORY_CHARS,
    );
  });

  it("caps oversize compaction summary while preserving recent post-summary tail", () => {
    // Two regressions covered here:
    // 1. `tailRaw.slice(-0)` would return the entire tail (JS quirk:
    //    `String.prototype.slice(-0) === slice(0)`), defeating the cap when
    //    the summary block consumes the budget.
    // 2. Pinning the full summary as-is when the summary itself exceeds
    //    `maxHistoryChars` would blow past the cap that prevents
    //    reseeding fresh CLI sessions with unexpectedly huge prompts.
    //    The summary must itself be truncated to fit the budget while still
    //    preserving the recent post-summary exact turns.
    const summaryText = "OVERSIZE_SUMMARY_MARKER ".repeat(50).trim();
    const historyBudget = 200;
    const maxHistoryChars = withReseedGuidanceBudget(historyBudget);
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: summaryText },
        { role: "user", content: "POST_SUMMARY_USER_DROPPED" },
        { role: "assistant", content: "POST_SUMMARY_ASSISTANT_DROPPED" },
      ],
      prompt: "next ask",
      // Cap well below the rendered summary block so the summary itself
      // must be truncated and the tail budget would naively be 0.
      maxHistoryChars,
    });

    expect(prompt).toBeDefined();
    // The truncated summary still leads with recognizable load-bearing
    // text — head-slicing preserves the orientation/intro of the summary.
    expect(prompt).toContain("OVERSIZE_SUMMARY_MARKER");
    expect(prompt).toContain("Compaction summary:");
    // The leading truncation marker is present so the prompt announces
    // what was discarded.
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // The cap is honored: the rendered <conversation_history> block
    // must not blow past `maxHistoryChars` plus a small wrapper allowance.
    const historyMatch = prompt?.match(
      /<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/,
    );
    expect(historyMatch).not.toBeNull();
    const renderedHistory = historyMatch?.[1] ?? "";
    expect(renderedHistory.length).toBeLessThanOrEqual(maxHistoryChars);
    // The full untruncated summary must NOT appear — that would defeat
    // the cap.
    expect(prompt).not.toContain(summaryText);
    // Post-summary exact turns are newer than the summary and must still
    // survive inside the reserved tail budget.
    expect(prompt).toContain("POST_SUMMARY_USER_DROPPED");
    expect(prompt).toContain("POST_SUMMARY_ASSISTANT_DROPPED");
    expect(prompt).toContain("<next_user_message>\nnext ask\n</next_user_message>");
  });

  it("keeps a whole code point at an oversize compaction-summary boundary", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [{ role: "compactionSummary", summary: `aa😀${"z".repeat(100)}` }],
      prompt: "next",
      maxHistoryChars: withReseedGuidanceBudget(80),
    });

    expect(prompt).toContain(
      `<conversation_history>\n${RESEED_CURRENCY_GUIDANCE}\n[OpenClaw reseed history truncated; older turns dropped]\nCompaction summary: aa\n</conversation_history>`,
    );
  });

  it("honors the cap when the summary block plus marker crosses it", () => {
    // Edge case: the summary fits but leaves too little room for the
    // truncation marker plus a useful exact tail. Rebalance the summary and
    // tail instead of exceeding the cap or silently dropping the marker.
    const historyBudget = 200;
    const maxHistoryChars = withReseedGuidanceBudget(historyBudget);
    const remainingBudget = 10;
    const summaryPrefix = "Compaction summary: ";
    const summaryText = "S".repeat(
      historyBudget - remainingBudget - "\n\n".length - summaryPrefix.length,
    );
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: summaryText },
        { role: "user", content: "POST_SUMMARY_TAIL_USER" },
        { role: "assistant", content: "POST_SUMMARY_TAIL_ASSISTANT" },
      ],
      prompt: "next ask",
      maxHistoryChars,
    });

    expect(prompt).toBeDefined();
    const historyMatch = prompt?.match(
      /<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/,
    );
    expect(historyMatch).not.toBeNull();
    const renderedHistory = historyMatch?.[1] ?? "";
    expect(renderedHistory.length).toBeLessThanOrEqual(maxHistoryChars);
    // Marker is still present so the prompt announces what was discarded.
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // Near-cap summaries still reserve room for the newest exact turns.
    expect(prompt).toContain("POST_SUMMARY_TAIL_USER");
    expect(prompt).toContain("POST_SUMMARY_TAIL_ASSISTANT");
  });

  it("keeps fitting post-summary history without a false truncation marker", () => {
    const historyBudget = 200;
    const remainingBudget = 10;
    const summaryPrefix = "Compaction summary: ";
    const summaryText = "S".repeat(
      historyBudget - remainingBudget - "\n\n".length - summaryPrefix.length,
    );
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: summaryText },
        { role: "user", content: "tail" },
      ],
      prompt: "next ask",
      maxHistoryChars: withReseedGuidanceBudget(historyBudget),
    });

    expect(prompt).toContain(`Compaction summary: ${summaryText}`);
    expect(prompt).toContain("User: tail");
    expect(prompt).not.toContain("[OpenClaw reseed history truncated; older turns dropped]");
  });
});
