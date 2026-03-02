import { describe, it, expect } from "vitest";
import { RulesEngine } from "./engine.js";
import type { HarnessRule } from "./rules.js";

describe("RulesEngine", () => {
  const builtinRules: HarnessRule[] = [
    { tool: "email.delete", when: { count: ">10" }, tier: "block", reason: "Bulk email deletion" },
    { tool: "contacts.export", tier: "block", reason: "Bulk contact export" },
  ];

  it("matches a built-in rule (Layer 1)", () => {
    const engine = new RulesEngine(builtinRules, [], []);
    const result = engine.classify("contacts.export", {});
    expect(result.tier).toBe("block");
    expect(result.layer).toBe(1);
    expect(result.reason).toBe("Bulk contact export");
  });

  it("matches built-in rule with condition", () => {
    const engine = new RulesEngine(builtinRules, [], []);
    const result = engine.classify("email.delete", { count: 15 });
    expect(result.tier).toBe("block");
    expect(result.layer).toBe(1);
  });

  it("falls through to operator rules (Layer 2)", () => {
    const operatorRules: HarnessRule[] = [
      { tool: "email.send", tier: "confirm", reason: "Operator: confirm all sends" },
    ];
    const engine = new RulesEngine(builtinRules, operatorRules, []);
    const result = engine.classify("email.send", {});
    expect(result.tier).toBe("confirm");
    expect(result.layer).toBe(2);
  });

  it("falls through to client rules (Layer 3)", () => {
    const clientRules: HarnessRule[] = [
      { tool: "email.send", tier: "allow", reason: "Client: always allow sends" },
    ];
    const engine = new RulesEngine(builtinRules, [], clientRules);
    const result = engine.classify("email.send", {});
    expect(result.tier).toBe("allow");
    expect(result.layer).toBe(3);
  });

  it("falls through to verb-based default when no rule matches", () => {
    const engine = new RulesEngine(builtinRules, [], []);
    // email.get → verb "read" → default tier "allow"
    const result = engine.classify("email.get", {});
    expect(result.tier).toBe("allow");
    expect(result.layer).toBeUndefined();
    expect(result.reason).toContain("verb default");
  });

  it("defaults unknown verbs to confirm", () => {
    const engine = new RulesEngine(builtinRules, [], []);
    const result = engine.classify("some.weirdaction", {});
    expect(result.tier).toBe("confirm");
    expect(result.reason).toContain("unknown verb");
  });

  it("Layer 1 takes priority over Layer 2 and 3", () => {
    const operatorRules: HarnessRule[] = [
      { tool: "contacts.export", tier: "allow", reason: "Operator tried to weaken" },
    ];
    const clientRules: HarnessRule[] = [
      { tool: "contacts.export", tier: "allow", reason: "Client tried to weaken" },
    ];
    const engine = new RulesEngine(builtinRules, operatorRules, clientRules);
    const result = engine.classify("contacts.export", {});
    expect(result.tier).toBe("block");
    expect(result.layer).toBe(1);
  });

  it("does not match built-in when condition not met", () => {
    const operatorRules: HarnessRule[] = [
      { tool: "email.delete", tier: "confirm", reason: "Operator: confirm deletes" },
    ];
    const engine = new RulesEngine(builtinRules, operatorRules, []);
    // count=5, so built-in ">10" doesn't match, falls to operator
    const result = engine.classify("email.delete", { count: 5 });
    expect(result.tier).toBe("confirm");
    expect(result.layer).toBe(2);
  });

  it("picks most restrictive rule within a layer (Gap 11)", () => {
    const operatorRules: HarnessRule[] = [
      { tool: "email.send", tier: "allow", reason: "Allow sends" },
      { tool: "email.*", tier: "confirm", reason: "Confirm all email ops" },
    ];
    const engine = new RulesEngine([], operatorRules, []);
    // Both rules match email.send — "confirm" is more restrictive than "allow"
    const result = engine.classify("email.send", {});
    expect(result.tier).toBe("confirm");
    expect(result.layer).toBe(2);
  });
});
