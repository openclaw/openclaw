// RI-011 — Rationalization engine tests
// Covers: rule matching in prose + params, action precedence, severity
// mapping, require_override fallback to warn, rule override for tests,
// window append helper, malformed-regex safety, no-match returns.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  __setRationalizationRulesForTest,
  appendToAssistantWindow,
  evaluateToolCall,
  getRationalizationRules,
  type RationalizationRule,
} from "./rationalization-engine.js";

beforeEach(() => {
  __setRationalizationRulesForTest(null); // reset to default catalog
});

afterEach(() => {
  __setRationalizationRulesForTest(null);
});

describe("evaluateToolCall — default catalog", () => {
  it("matches skip-tests-later rationalization in assistant prose", () => {
    const r = evaluateToolCall({
      toolName: "write",
      params: {},
      recentAssistantText:
        "I'll add tests in the next iteration, this is just scaffolding.",
    });
    expect(r.matched).toBe(true);
    expect(r.rule?.id).toBe("skip-tests-later");
    expect(r.matchedIn).toBe("assistant-text");
    expect(r.action).toBe("warn");
  });

  it("matches low-risk-skip-review as require_override", () => {
    const r = evaluateToolCall({
      toolName: "bash",
      params: {},
      recentAssistantText:
        "This is a small change so we can skip review and merge directly.",
    });
    expect(r.matched).toBe(true);
    expect(r.rule?.id).toBe("low-risk-skip-review");
    expect(r.action).toBe("require_override");
    expect(r.reason).toBeTruthy();
  });

  it("maps require_override to warn when requireOverrideBlocks=false", () => {
    const r = evaluateToolCall({
      toolName: "bash",
      params: {},
      recentAssistantText: "This is a minor change, we can skip the review.",
      requireOverrideBlocks: false,
    });
    expect(r.action).toBe("warn");
    expect(r.reason).toBeUndefined();
  });

  it("blocks rm -rf in tool params regardless of prose", () => {
    const r = evaluateToolCall({
      toolName: "bash",
      params: { command: "rm -rf /" },
      recentAssistantText: "",
    });
    expect(r.matched).toBe(true);
    expect(r.rule?.id).toBe("rm-rf-cleanup");
    expect(r.action).toBe("block");
    expect(r.matchedIn).toBe("tool-params");
  });

  it("blocks force-push to main", () => {
    const r = evaluateToolCall({
      toolName: "bash",
      params: { command: "git push --force-with-lease origin main" },
      recentAssistantText: "",
    });
    expect(r.matched).toBe(true);
    expect(r.rule?.id).toBe("force-push-main-safe");
    expect(r.action).toBe("block");
  });

  it("flags --no-verify on commit as require_override", () => {
    const r = evaluateToolCall({
      toolName: "bash",
      params: { command: "git commit --no-verify -m 'quick fix'" },
      recentAssistantText: "",
    });
    expect(r.matched).toBe(true);
    expect(r.rule?.id).toBe("disable-hook-to-commit");
    expect(r.action).toBe("require_override");
  });

  it("returns matched=false for clean prose + params", () => {
    const r = evaluateToolCall({
      toolName: "read",
      params: { file_path: "/workspace/README.md" },
      recentAssistantText: "Let me check the README to understand the project.",
    });
    expect(r.matched).toBe(false);
    expect(r.rule).toBeUndefined();
  });

  it("is case-insensitive", () => {
    const r = evaluateToolCall({
      toolName: "bash",
      params: { command: "RM -RF /OPT/old-build" },
      recentAssistantText: "",
    });
    expect(r.matched).toBe(true);
    expect(r.rule?.id).toBe("rm-rf-cleanup");
  });

  it("handles null/undefined params without throwing", () => {
    const r1 = evaluateToolCall({
      toolName: "x",
      params: null,
      recentAssistantText: "",
    });
    expect(r1.matched).toBe(false);
    const r2 = evaluateToolCall({
      toolName: "x",
      params: undefined,
      recentAssistantText: "",
    });
    expect(r2.matched).toBe(false);
  });

  it("detects skip-auth-check-internal as critical require_override", () => {
    const r = evaluateToolCall({
      toolName: "write",
      params: {
        file_path: "/app/routes.ts",
        content:
          "// admin-only endpoint, no need for auth since it's internal",
      },
      recentAssistantText: "",
    });
    expect(r.matched).toBe(true);
    expect(r.rule?.id).toBe("skip-auth-check-internal");
    expect(r.rule?.severity).toBe("critical");
    expect(r.action).toBe("require_override");
  });
});

describe("evaluateToolCall — rule override for tests", () => {
  it("honors a custom rule catalog", () => {
    const customRule: RationalizationRule = {
      id: "custom-test",
      category: "testing",
      severity: "high",
      pattern: "ship it yolo",
      rebuttal: "Don't ship it yolo.",
      action: "block",
    };
    __setRationalizationRulesForTest([customRule]);
    const r = evaluateToolCall({
      toolName: "bash",
      params: { command: "deploy" },
      recentAssistantText: "ship it yolo",
    });
    expect(r.matched).toBe(true);
    expect(r.rule?.id).toBe("custom-test");
    expect(r.action).toBe("block");
  });

  it("reports no rules when catalog is empty", () => {
    __setRationalizationRulesForTest([]);
    const r = evaluateToolCall({
      toolName: "bash",
      params: { command: "rm -rf /" },
      recentAssistantText: "force-push to main",
    });
    expect(r.matched).toBe(false);
    expect(getRationalizationRules().length).toBe(0);
  });

  it("survives a malformed regex without throwing", () => {
    const bad: RationalizationRule = {
      id: "malformed",
      category: "testing",
      severity: "low",
      pattern: "(", // invalid regex
      rebuttal: "test",
      action: "warn",
    };
    __setRationalizationRulesForTest([bad]);
    expect(() =>
      evaluateToolCall({
        toolName: "bash",
        params: {},
        recentAssistantText: "anything here",
      }),
    ).not.toThrow();
  });
});

describe("appendToAssistantWindow", () => {
  it("concatenates lines with newlines", () => {
    const a = appendToAssistantWindow("", "first line");
    expect(a).toBe("first line");
    const b = appendToAssistantWindow(a, "second line");
    expect(b).toBe("first line\nsecond line");
  });

  it("trims the left side when window exceeds cap", () => {
    const cap = 20;
    const initial = "0123456789"; // 10 chars
    const stepA = appendToAssistantWindow(initial, "abcdefghij", cap);
    // initial + \n + abcdefghij = 21 chars → trimmed to 20
    expect(stepA.length).toBe(cap);
    // Most recent chars preserved
    expect(stepA.endsWith("abcdefghij")).toBe(true);
  });

  it("handles empty prior window", () => {
    const a = appendToAssistantWindow("", "hello world");
    expect(a).toBe("hello world");
  });

  it("preserves most recent data when cap is tiny", () => {
    const out = appendToAssistantWindow("discarded", "kept", 4);
    expect(out).toBe("kept");
  });
});
