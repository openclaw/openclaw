const fs = require("fs");
const path = require("path");

// Fix 1: Make ResolvedBehaviorRule and validateBehaviorOutput non-exported
let policy = fs.readFileSync("C:/dev/openclaw/src/security/behavior-policy.ts", "utf8");
policy = policy.replace("export type ResolvedBehaviorRule", "type ResolvedBehaviorRule");
policy = policy.replace(
  "export async function validateBehaviorOutput",
  "async function validateBehaviorOutput",
);
fs.writeFileSync("C:/dev/openclaw/src/security/behavior-policy.ts", policy, "utf8");
console.log("Fixed behavior-policy.ts");

// Fix 2: Fix test file
let test = fs.readFileSync("C:/dev/openclaw/src/security/behavior-policy.test.ts", "utf8");

// Replace the rules-guarded test block
const oldBlock = `    it("returns resolved rules with defaults applied", () => {
      const cfg = makeConfig([SAMPLE_RULE, SAMPLE_RULE_GUIDE]);
      const rules = resolveBehaviorRules(cfg);
      expect(rules).toBeDefined();
      expect(rules!).toHaveLength(2);
      expect(rules![0].id).toBe("test-no-secrets");
      expect(rules![0].mode).toBe("enforce");
      expect(rules![1].id).toBe("test-politeness");
      expect(rules![1].mode).toBe("guide");
    });`;

const newBlock = `    it("returns resolved rules with defaults applied", () => {
      const cfg = makeConfig([SAMPLE_RULE, SAMPLE_RULE_GUIDE]);
      const rules = resolveBehaviorRules(cfg);
      expect(rules).toBeDefined();
      if (rules) {
        expect(rules).toHaveLength(2);
        expect(rules[0].id).toBe("test-no-secrets");
        expect(rules[0].mode).toBe("enforce");
        expect(rules[1].id).toBe("test-politeness");
        expect(rules[1].mode).toBe("guide");
      }
    });`;

test = test.replace(oldBlock, newBlock);

// Fix violations assertion
test = test.replace(
  "expect(result.violations!.length).toBe(1);",
  "expect(result.violations && result.violations.length || 0).toBe(1);",
);

test = test.replace(
  'expect(result.violations![0].ruleId).toBe("no-secrets");',
  'if (result.violations) { expect(result.violations[0].ruleId).toBe("no-secrets"); }',
);

fs.writeFileSync("C:/dev/openclaw/src/security/behavior-policy.test.ts", test, "utf8");
console.log("Fixed behavior-policy.test.ts");

console.log("All fixes applied");
