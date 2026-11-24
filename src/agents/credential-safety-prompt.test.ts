import { describe, expect, it } from "vitest";
import { buildCredentialSafetyPrompt } from "./credential-safety-prompt.js";

describe("buildCredentialSafetyPrompt", () => {
  it.each([
    { name: "unavailable controls", input: { controlToolsAvailable: false }, lines: 4 },
    { name: "available controls", input: { controlToolsAvailable: true }, lines: 3 },
    { name: "legacy tool name", input: "legacy-secrets-tool", lines: 2 },
    { name: "omitted availability", input: undefined, lines: 2 },
    { name: "unknown availability", input: {}, lines: 2 },
  ])("scopes guidance to known availability for $name", ({ input, lines }) => {
    const prompt = buildCredentialSafetyPrompt(input);

    // Legacy and unknown callers keep handoff-only credential guidance.
    expect(prompt.split("\n")).toHaveLength(lines);
    expect(prompt.includes("openclaw channels add <channel>")).toBe(lines === 4);
    expect(prompt.includes("User-supplied credentials:")).toBe(lines > 2);
    expect(prompt.includes("without repeating values")).toBe(lines > 2);
    expect(prompt.includes("factually acknowledge")).toBe(lines > 2);
    expect(prompt).not.toContain("legacy-secrets-tool");
  });
});
