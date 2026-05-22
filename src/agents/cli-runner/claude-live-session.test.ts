import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { summarizePromptForLog } from "./claude-live-session.js";

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
