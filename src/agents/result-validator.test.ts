import { describe, expect, it, vi } from "vitest";
import type { OutputRole } from "./output-budget.js";
import { validateResult, validateResultSync } from "./result-validator.js";

describe("validateResult", () => {
  it("passes valid short output for dispatcher", async () => {
    const result = await validateResult({
      output: "Routed to executor.",
      sessionKey: "agent:main:main",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.role).toBe("dispatcher");
    }
  });

  it("passes valid output for planner", async () => {
    const result = await validateResult({
      output: "Plan: Step 1: Do X. Step 2: Do Y.",
      sessionKey: "agent:main:subagent:abc",
      subagentLabel: "planning-phase",
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.role).toBe("planner");
    }
  });

  it("rejects oversized output for maintenance role", async () => {
    const largeOutput = "word ".repeat(1000);
    const result = await validateResult({
      output: largeOutput,
      sessionKey: "cron:daily",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("budget_exceeded");
      expect(result.role).toBe("maintenance");
    }
  });

  it("returns fallback output on budget violation", async () => {
    const largeOutput = "data ".repeat(1000);
    const result = await validateResult({
      output: largeOutput,
      role: "maintenance",
    });
    expect(result.valid).toBe(false);
    if (!result.valid && result.reason === "budget_exceeded") {
      expect(result.fallbackOutput).toContain("Output budget exceeded");
      expect(result.fallbackOutput).toContain("Summary:");
    }
  });

  it("stores oversized output as artifact when registry provided", async () => {
    const mockRegistry = {
      storeText: vi
        .fn()
        .mockResolvedValue({
          id: "sha256-abc",
          mime: "text/plain",
          createdAt: new Date().toISOString(),
          sha256: "sha256-abc",
          sizeBytes: 5000,
        }),
      storeJson: vi.fn(),
      get: vi.fn(),
    };

    const largeOutput = "data ".repeat(1000);
    const result = await validateResult({
      output: largeOutput,
      role: "maintenance",
      artifactRegistry: mockRegistry,
    });

    expect(result.valid).toBe(false);
    if (!result.valid && result.reason === "budget_exceeded") {
      expect(mockRegistry.storeText).toHaveBeenCalled();
      expect(result.artifactId).toBe("sha256-abc");
      expect(result.fallbackOutput).toContain("sha256-abc");
    }
  });

  it("rejects full file rewrite for code modification", async () => {
    const lines = [];
    lines.push("import fs from 'node:fs';");
    for (let i = 0; i < 30; i++) {
      lines.push(`function handler${i}() { return ${i}; }`);
    }

    const result = await validateResult({
      output: lines.join("\n"),
      role: "executor",
      taskDescription: "modify the handler.ts file",
      skipBudget: true, // focus on diff check
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("diff_only_violation");
    }
  });

  it("passes valid diff output for code modification", async () => {
    const diffOutput = `--- a/handler.ts
+++ b/handler.ts
@@ -5,3 +5,4 @@
 export function handle() {
+  validate();
   process();
 }`;

    const result = await validateResult({
      output: diffOutput,
      role: "executor",
      taskDescription: "modify the handler.ts file",
      skipBudget: true,
    });

    expect(result.valid).toBe(true);
  });

  it("skips budget check when skipBudget is true", async () => {
    const largeOutput = "word ".repeat(1000);
    const result = await validateResult({
      output: largeOutput,
      role: "maintenance",
      skipBudget: true,
    });
    expect(result.valid).toBe(true);
  });

  it("skips diff check when skipDiff is true", async () => {
    const lines = [];
    lines.push("import fs from 'node:fs';");
    for (let i = 0; i < 30; i++) {
      lines.push(`function handler${i}() { return ${i}; }`);
    }

    const result = await validateResult({
      output: lines.join("\n"),
      role: "executor",
      taskDescription: "modify the handler.ts file",
      skipBudget: true,
      skipDiff: true,
    });

    expect(result.valid).toBe(true);
  });

  it("handles explicit role override", async () => {
    const result = await validateResult({
      output: "Short reply",
      sessionKey: "agent:main:main", // would infer dispatcher
      role: "planner", // explicit override
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.role).toBe("planner");
    }
  });

  it("budget is checked before diff (budget violation takes priority)", async () => {
    // Generate output that violates both budget AND diff-only
    const lines = [];
    lines.push("import fs from 'node:fs';");
    for (let i = 0; i < 300; i++) {
      lines.push(`function handler${i}() { return ${i}; }`);
    }
    const hugeRewrite = lines.join("\n");

    const result = await validateResult({
      output: hugeRewrite,
      role: "maintenance", // smallest budget (600)
      taskDescription: "modify the source code",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      // Budget is checked first, so this should be the reason
      expect(result.reason).toBe("budget_exceeded");
    }
  });
});

describe("validateResultSync", () => {
  it("returns null when within budget", () => {
    const result = validateResultSync({
      output: "Quick reply",
      role: "dispatcher",
    });
    expect(result).toBeNull();
  });

  it("returns violation for oversized output", () => {
    const result = validateResultSync({
      output: "word ".repeat(1000),
      role: "maintenance",
    });
    expect(result).not.toBeNull();
    expect(result?.role).toBe("maintenance");
  });

  it("respects budget overrides", () => {
    // With default budget (600), "word " * 1000 ≈ 1250 tokens should exceed
    const text = "word ".repeat(1000);
    const defaultResult = validateResultSync({
      output: text,
      role: "maintenance",
    });
    // With generous override, should pass
    const overrideResult = validateResultSync({
      output: text,
      role: "maintenance",
      budgetOverrides: { maintenance: 50000 },
    });
    expect(defaultResult).not.toBeNull();
    expect(overrideResult).toBeNull();
  });
});

describe("role inference integration", () => {
  const testCases: Array<{ sessionKey: string; label?: string; expectedRole: OutputRole }> = [
    { sessionKey: "agent:main:main", expectedRole: "dispatcher" },
    { sessionKey: "agent:ada:main", expectedRole: "dispatcher" },
    { sessionKey: "agent:main:subagent:uuid", expectedRole: "executor" },
    { sessionKey: "agent:main:subagent:uuid", label: "plan-something", expectedRole: "planner" },
    { sessionKey: "agent:main:subagent:uuid", label: "deep-reasoning", expectedRole: "reasoner" },
    { sessionKey: "cron:heartbeat-check", expectedRole: "maintenance" },
    { sessionKey: "heartbeat:poll", expectedRole: "maintenance" },
  ];

  for (const tc of testCases) {
    it(`infers ${tc.expectedRole} from sessionKey=${tc.sessionKey} label=${tc.label ?? "none"}`, async () => {
      const result = await validateResult({
        output: "ok",
        sessionKey: tc.sessionKey,
        subagentLabel: tc.label,
        skipBudget: true,
        skipDiff: true,
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.role).toBe(tc.expectedRole);
      }
    });
  }
});
