import { describe, expect, it } from "vitest";
import { validateBashCommand } from "./bash-validation.js";

describe("bash validation", () => {
  it("skips unsupported shell syntax to preserve existing preflight fallback paths", () => {
    const warnings = validateBashCommand({
      command: "echo hi; echo bye",
      security: "full",
      ask: "off",
    });
    expect(warnings).toEqual([]);
  });

  it("warns on traversal-like arguments", () => {
    const warnings = validateBashCommand({
      command: "cat ../secret.txt",
      security: "full",
      ask: "off",
    });
    expect(warnings.some((entry) => entry.includes("relative parent path"))).toBe(true);
  });

  it("blocks destructive commands in allowlist ask=off mode", () => {
    expect(() =>
      validateBashCommand({
        command: "rm -rf /",
        security: "allowlist",
        ask: "off",
      }),
    ).toThrow(/destructive commands require interactive approval/i);
  });
});
