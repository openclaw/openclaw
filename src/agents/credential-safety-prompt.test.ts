import { describe, expect, it } from "vitest";
import { buildCredentialSafetyPrompt } from "./credential-safety-prompt.js";

describe("buildCredentialSafetyPrompt", () => {
  it.each([
    { name: "unavailable controls", input: { controlToolsAvailable: false }, terminalSetup: true },
    { name: "available controls", input: { controlToolsAvailable: true }, terminalSetup: false },
    { name: "legacy tool name", input: "legacy-secrets-tool", terminalSetup: false },
    { name: "omitted availability", input: undefined, terminalSetup: false },
    { name: "unknown availability", input: {}, terminalSetup: false },
  ])("routes terminal setup only for $name", ({ input, terminalSetup }) => {
    const prompt = buildCredentialSafetyPrompt(input);

    expect(prompt.split("\n")).toHaveLength(terminalSetup ? 3 : 2);
    expect(prompt.includes("openclaw channels add <channel>")).toBe(terminalSetup);
    expect(prompt).not.toContain("legacy-secrets-tool");
  });
});
