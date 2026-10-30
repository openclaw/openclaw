import { describe, expect, it } from "vitest";
import { buildCredentialSafetyPrompt } from "./credential-safety-prompt.js";

describe("buildCredentialSafetyPrompt", () => {
  it.each([
    { name: "unavailable controls", input: { controlToolsAvailable: false }, lines: 3 },
    { name: "available controls", input: { controlToolsAvailable: true }, lines: 2 },
    { name: "legacy tool name", input: "legacy-secrets-tool", lines: 1 },
    { name: "omitted availability", input: undefined, lines: 1 },
    { name: "unknown availability", input: {}, lines: 1 },
  ])("scopes guidance to known availability for $name", ({ input, lines }) => {
    const prompt = buildCredentialSafetyPrompt(input);

    // Legacy and unknown callers keep the documented handoff-only result.
    expect(prompt.split("\n")).toHaveLength(lines);
    expect(prompt.includes("openclaw channels add <channel>")).toBe(lines === 3);
    expect(prompt.includes("In the final reply, briefly acknowledge")).toBe(lines > 1);
    expect(prompt.includes("without repeating its value")).toBe(lines > 1);
    expect(prompt.includes("factual and non-alarming")).toBe(lines > 1);
    expect(prompt).not.toContain("legacy-secrets-tool");
  });
});
