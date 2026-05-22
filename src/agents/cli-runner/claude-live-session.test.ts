import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildClaudeLiveTurnFailedLogLine } from "./claude-live-session.js";
import { buildCliExecLogLine, generateCliTurnId, summarizePromptForLog } from "./execute.js";

describe("summarizePromptForLog", () => {
  it("reports the UTF-16 length of the prompt", () => {
    expect(summarizePromptForLog("").chars).toBe(0);
    expect(summarizePromptForLog("hello").chars).toBe(5);
    expect(summarizePromptForLog("héllo").chars).toBe("héllo".length);
  });

  it("returns the first 8 hex characters of the prompt's SHA-256 digest", () => {
    const prompt = "preserve me on abort";
    const expected = crypto.createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 8);
    expect(summarizePromptForLog(prompt).hash).toBe(expected);
    expect(summarizePromptForLog(prompt).hash).toHaveLength(8);
  });

  it("yields a stable hash across repeated calls for the same prompt", () => {
    const prompt = "same prompt, same hash";
    expect(summarizePromptForLog(prompt).hash).toBe(summarizePromptForLog(prompt).hash);
  });

  it("yields different hashes for different prompts", () => {
    expect(summarizePromptForLog("a").hash).not.toBe(summarizePromptForLog("b").hash);
  });
});

describe("generateCliTurnId", () => {
  it("returns an 8-character lowercase hex string", () => {
    const turnId = generateCliTurnId();
    expect(turnId).toMatch(/^[0-9a-f]{8}$/);
  });

  it("yields a different id on successive calls", () => {
    expect(generateCliTurnId()).not.toBe(generateCliTurnId());
  });
});

describe("buildClaudeLiveTurnFailedLogLine", () => {
  it("emits the correlation fields verbatim from the input", () => {
    const line = buildClaudeLiveTurnFailedLogLine({
      provider: "claude-cli",
      model: "claude-opus-4-7",
      durationMs: 384_321,
      errorKind: "FailoverError",
      correlation: { turnId: "deadbeef", promptChars: 1024, promptHash: "feedface" },
    });

    expect(line).toContain("claude live session turn failed:");
    expect(line).toContain("provider=claude-cli");
    expect(line).toContain("model=claude-opus-4-7");
    expect(line).toContain("durationMs=384321");
    expect(line).toContain("error=FailoverError");
    expect(line).toContain("turnId=deadbeef");
    expect(line).toContain("promptChars=1024");
    expect(line).toContain("promptHash=feedface");
  });

  it("stays correlated with the cli exec line even when downstream transforms change the prompt length", () => {
    // Regression for the bot-flagged defect: previously the abort log hashed
    // the post-transform prompt local to claude-live-session.ts, while the
    // `cli exec: …` line in execute.ts logged basePrompt.length. Bootstrap
    // warnings, plugin text transforms, and image-marker injection happen
    // between the two sites, so the two `promptChars` values diverged. The
    // contract now is: execute.ts computes summarizePromptForLog(basePrompt)
    // ONCE, generates a turnId ONCE, and passes both into the live session.
    const basePrompt = "user-visible message that becomes the cli exec promptChars source";
    const downstreamPromptWithTransforms =
      "[bootstrap warning prepended]\n" +
      basePrompt +
      "\n[Image #1] [Image #2]"; /* image-marker injection */
    expect(downstreamPromptWithTransforms.length).not.toBe(basePrompt.length);

    const summary = summarizePromptForLog(basePrompt);
    const turnId = generateCliTurnId();

    const execLine = buildCliExecLogLine({
      provider: "claude-cli",
      model: "claude-opus-4-7",
      turnId,
      promptChars: summary.chars,
      trigger: "user",
      useResume: false,
      hasHistoryPrompt: false,
    });
    const failLine = buildClaudeLiveTurnFailedLogLine({
      provider: "claude-cli",
      model: "claude-opus-4-7",
      durationMs: 6_400_000,
      errorKind: "FailoverError",
      correlation: { turnId, promptChars: summary.chars, promptHash: summary.hash },
    });

    expect(execLine).toContain(`turnId=${turnId}`);
    expect(failLine).toContain(`turnId=${turnId}`);
    expect(execLine).toContain(`promptChars=${summary.chars}`);
    expect(failLine).toContain(`promptChars=${summary.chars}`);
    // The post-transform length must NOT appear on the abort line — that was
    // exactly the divergence the previous implementation introduced.
    expect(failLine).not.toContain(`promptChars=${downstreamPromptWithTransforms.length}`);
  });
});
