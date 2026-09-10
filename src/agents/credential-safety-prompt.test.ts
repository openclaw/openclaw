import { describe, expect, it } from "vitest";
import { buildCredentialSafetyPrompt } from "./credential-safety-prompt.js";

describe("buildCredentialSafetyPrompt", () => {
  it.each([
    { name: "unavailable controls", input: { controlToolsAvailable: false }, terminalSetup: true },
    { name: "available controls", input: { controlToolsAvailable: true }, terminalSetup: false },
    { name: "legacy tool name", input: "legacy-secrets-tool", terminalSetup: false },
    { name: "omitted availability", input: undefined, terminalSetup: false },
    { name: "unknown availability", input: {}, terminalSetup: false },
  ])("preserves private handoff and routes setup with $name", ({ input, terminalSetup }) => {
    const prompt = buildCredentialSafetyPrompt(input);
    const lines = prompt.split("\n");

    expect(lines).toHaveLength(terminalSetup ? 2 : 1);
    expect(lines[0]).toContain("For user-requested login or pairing in a group");
    expect(lines[0]).toContain("only to the requesting user in private");
    expect(lines[0]).toContain("then acknowledge in the group without them");
    expect(prompt.includes("openclaw channels add <channel>")).toBe(terminalSetup);
    expect(prompt.includes("openclaw configure")).toBe(terminalSetup);
    expect(prompt).not.toContain("legacy-secrets-tool");
  });
});
