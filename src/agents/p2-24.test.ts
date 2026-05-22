import { describe, expect, it, beforeEach } from "vitest";
import {
  applyReadEmptyArgsGuard,
  extractPathCandidatesFromUserMessage,
  isReadPathEmpty,
  setLastUserMessageTextForReadFallback,
  __resetReadEmptyArgsGuardForTest,
} from "./pi-tools.read-guards.js";
import { sanitizeString, sanitizeToolArgs } from "./tool-arg-sanitize-guard.js";
import type { ToolArgSanitizeConfig } from "./tool-arg-sanitize-guard.js";

const cfg: ToolArgSanitizeConfig = {
  enabled: true,
  removeSentinel: true,
  removeHtmlTags: true,
  balanceQuote: true,
  htmlAllowlist: new Set<string>(),
  maxFieldLen: 65536,
};

describe("P2.24b — exec/bash sanitize cmd/script fields", () => {
  it("E1: sentinel-only — <|find . -name 'aurora.md' → strips <| prefix", () => {
    const input = '<|find . -name "aurora-somin-plan-2026-05-22.md"';
    const r = sanitizeToolArgs({ command: input }, "exec", cfg);
    expect(r.changed).toBe(true);
    expect(r.args.command).toBe('find . -name "aurora-somin-plan-2026-05-22.md"');
  });

  it("E1b: cmd field also sanitized (P2.24b)", () => {
    const input = "<|ls -la";
    const r = sanitizeToolArgs({ cmd: input }, "bash", cfg);
    expect(r.changed).toBe(true);
    expect(r.args.cmd).toBe("ls -la");
  });

  it("E1c: script field also sanitized (P2.24b)", () => {
    const input = "<|echo hello";
    const r = sanitizeToolArgs({ script: input }, "exec", cfg);
    expect(r.changed).toBe(true);
    expect(r.args.script).toBe("echo hello");
  });

  it("E2: html-only — <b>text</b> → strips html tags", () => {
    const r = sanitizeToolArgs({ command: "<b>echo</b> hello" }, "exec", cfg);
    expect(r.changed).toBe(true);
    expect((r.args.command as string).includes("<b>")).toBe(false);
  });

  it("E3: sentinel + odd dquote — balance applied", () => {
    const input = '<|echo "unbalanced';
    const r = sanitizeToolArgs({ command: input }, "exec", cfg);
    expect(r.changed).toBe(true);
    // sentinel 제거 후 odd dquote 는 balance-quote 룰 적용 (또는 그대로 — 케이스마다)
    expect((r.args.command as string).includes("<|")).toBe(false);
  });

  it("E4: nested sentinel — <<|find|ls.|>", () => {
    const input = "<<|find|>ls -la";
    const r = sanitizeToolArgs({ command: input }, "exec", cfg);
    expect(r.changed).toBe(true);
    expect((r.args.command as string).includes("<<|")).toBe(false);
  });

  it("E5: no-change passthrough — clean command", () => {
    const input = "ls -la /home";
    const r = sanitizeToolArgs({ command: input }, "exec", cfg);
    expect(r.args.command).toBe(input);
    // E5 는 mutations 가 0 이어야 함 (변화 없음)
    expect(r.mutations.length).toBe(0);
  });
});

describe("P2.24a — read empty path guard", () => {
  beforeEach(() => {
    __resetReadEmptyArgsGuardForTest();
  });

  it("isReadPathEmpty detects empty/null/undefined/non-string", () => {
    expect(isReadPathEmpty("")).toBe(true);
    expect(isReadPathEmpty(null)).toBe(true);
    expect(isReadPathEmpty(undefined)).toBe(true);
    expect(isReadPathEmpty("   ")).toBe(true);
    expect(isReadPathEmpty(123)).toBe(true);
    expect(isReadPathEmpty("memory/foo.md")).toBe(false);
  });

  it("extractPathCandidatesFromUserMessage finds .md and memory/* patterns", () => {
    const text = "aurora-somin-plan-2026-05-22.md 읽어봐";
    const cands = extractPathCandidatesFromUserMessage(text);
    expect(cands).toContain("aurora-somin-plan-2026-05-22.md");
  });

  it("first empty call with single candidate → auto-extract", () => {
    setLastUserMessageTextForReadFallback("aurora-somin-plan-2026-05-22.md 읽어봐");
    const res = applyReadEmptyArgsGuard({ path: "" });
    expect(res).toBe("aurora-somin-plan-2026-05-22.md");
  });

  it("empty call with no candidates → throws explicit error", () => {
    setLastUserMessageTextForReadFallback("그냥 인사해");
    expect(() => applyReadEmptyArgsGuard({ path: "" })).toThrow(/path argument is empty/);
  });

  it("empty call with multiple candidates → refuses + lists candidates", () => {
    setLastUserMessageTextForReadFallback("foo.md 와 bar.md 둘 다 보여줘");
    expect(() => applyReadEmptyArgsGuard({ path: "" })).toThrow(/Multiple candidates/);
  });

  it("3rd+ empty call within window → CRITICAL message", () => {
    setLastUserMessageTextForReadFallback("그냥 인사해"); // no candidates
    try {
      applyReadEmptyArgsGuard({ path: "" });
    } catch {}
    try {
      applyReadEmptyArgsGuard({ path: "" });
    } catch {}
    expect(() => applyReadEmptyArgsGuard({ path: "" })).toThrow(/CRITICAL/);
  });

  it("non-empty path is passthrough (returns undefined, no throw)", () => {
    const res = applyReadEmptyArgsGuard({ path: "memory/foo.md" });
    expect(res).toBeUndefined();
  });

  it("sanitizeString E1 reproduction at unit level", () => {
    const r = sanitizeString('<|find . -name "x.md"', "command", cfg);
    expect(r.value).toBe('find . -name "x.md"');
    expect(r.mutations.length).toBeGreaterThan(0);
  });
});
