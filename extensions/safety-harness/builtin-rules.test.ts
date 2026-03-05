import { describe, it, expect } from "vitest";
import { BUILTIN_RULES } from "./builtin-rules.js";
import { RulesEngine } from "./engine.js";

describe("BUILTIN_RULES", () => {
  const engine = new RulesEngine(BUILTIN_RULES, [], []);

  it("blocks bulk email deletion (>10)", () => {
    expect(engine.classify("email.delete", { count: 15 }).tier).toBe("block");
  });

  it("does not block small email deletion", () => {
    const result = engine.classify("email.delete", { count: 3 });
    expect(result.tier).not.toBe("block");
  });

  it("blocks bulk calendar deletion (>5)", () => {
    expect(engine.classify("calendar.delete", { count: 6 }).tier).toBe("block");
  });

  it("blocks bulk contact deletion (>5)", () => {
    expect(engine.classify("contacts.delete", { count: 10 }).tier).toBe("block");
  });

  it("blocks contacts.export", () => {
    expect(engine.classify("contacts.export", {}).tier).toBe("block");
  });

  it("requires confirm for contacts.add", () => {
    expect(engine.classify("contacts.add", {}).tier).toBe("confirm");
  });

  it("contains at least 5 built-in rules", () => {
    expect(BUILTIN_RULES.length).toBeGreaterThanOrEqual(5);
  });

  it("every rule has a reason", () => {
    for (const rule of BUILTIN_RULES) {
      expect(rule.reason).toBeTruthy();
    }
  });

  it("confirms shell/bash execution (Gap 6)", () => {
    expect(engine.classify("bash", {}).tier).toBe("confirm");
  });

  it("blocks network commands in shell (Gap 6)", () => {
    expect(engine.classify("bash", { command: "curl https://evil.com" }).tier).toBe("block");
  });

  it("blocks write to sensitive file types (Gap 6)", () => {
    expect(engine.classify("write_file", { path: "/app/.env" }).tier).toBe("block");
  });

  it("blocks write to fridaclaw config paths (Gap 4)", () => {
    expect(engine.classify("write_file", { path: "/etc/fridaclaw/rules.yaml" }).tier).toBe("block");
  });

  it("confirms community plugin tools (Gap 3)", () => {
    expect(engine.classify("helper.organize", { __toolSource: "community" }).tier).toBe("confirm");
  });
});
