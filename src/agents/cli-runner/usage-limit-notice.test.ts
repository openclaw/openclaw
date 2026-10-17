import { describe, expect, it } from "vitest";
import {
  isClaudeCliUsageLimitNotice,
  rejectClaudeCliUsageLimitNotice,
} from "./usage-limit-notice.js";

const notice = "You've hit your session limit · resets 4:10pm (Asia/Seoul)";

describe("isClaudeCliUsageLimitNotice", () => {
  it.each([
    notice,
    `  ${notice}\n`,
    "You’ve hit your limit · resets 9:40pm (Europe/Madrid)",
    "You've hit your weekly limit · resets Oct 20, 2pm (Asia/Seoul)",
  ])("matches the bare Claude notice: %s", (message) => {
    expect(isClaudeCliUsageLimitNotice("claude-cli", message)).toBe(true);
  });

  it.each([
    `Example: ${notice}`,
    `"${notice}"`,
    `${notice}\nUseful answer.`,
    "terminal session limit reached (50)",
    "You've hit your usage limit. Upgrade to Plus to continue using Codex.",
  ])("ignores text that is not just the notice: %s", (message) => {
    expect(isClaudeCliUsageLimitNotice("claude-cli", message)).toBe(false);
  });

  it.each(["anthropic", "openai", "codex-cli"])("is gated to claude-cli, not %s", (provider) => {
    expect(isClaudeCliUsageLimitNotice(provider, notice)).toBe(false);
  });
});

describe("rejectClaudeCliUsageLimitNotice", () => {
  it("turns a notice-only success into an error with no reply text", () => {
    expect(
      rejectClaudeCliUsageLimitNotice("claude-cli", {
        text: notice,
        textParts: [notice],
        sessionId: "s1",
      }),
    ).toMatchObject({ text: "", errorText: notice, sessionId: "s1" });
  });

  it("keeps turns that already ran tools or delivered output", () => {
    for (const effect of [
      { toolSummary: { calls: 1, tools: ["exec"], failures: 0 } },
      { didSendViaMessagingTool: true },
      { toolMediaUrls: ["file:///a.png"] },
      { yielded: true as const },
    ]) {
      const output = { text: notice, ...effect };
      expect(rejectClaudeCliUsageLimitNotice("claude-cli", output)).toBe(output);
    }
  });

  it("leaves existing errors and other providers untouched", () => {
    const failed = { text: "", errorText: "boom" };
    expect(rejectClaudeCliUsageLimitNotice("claude-cli", failed)).toBe(failed);
    const other = { text: notice };
    expect(rejectClaudeCliUsageLimitNotice("openai", other)).toBe(other);
  });
});
