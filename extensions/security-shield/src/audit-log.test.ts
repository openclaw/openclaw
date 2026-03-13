import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeAuditEntry, setAuditLogPath } from "./audit-log.js";

describe("writeAuditEntry", () => {
  const testPath = join(tmpdir(), `security-audit-test-${Date.now()}.jsonl`);

  beforeEach(() => {
    setAuditLogPath(testPath);
  });

  afterEach(() => {
    if (existsSync(testPath)) {
      unlinkSync(testPath);
    }
  });

  it("writes a JSONL entry", () => {
    writeAuditEntry({
      timestamp: "2026-01-01T00:00:00Z",
      toolName: "shell",
      params: '{"command": "ls"}',
      blocked: false,
      findings: [],
    });

    const content = readFileSync(testPath, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.toolName).toBe("shell");
    expect(entry.blocked).toBe(false);
  });

  it("truncates long params", () => {
    const longParams = "x".repeat(1000);
    writeAuditEntry({
      timestamp: "2026-01-01T00:00:00Z",
      toolName: "shell",
      params: longParams,
      blocked: false,
      findings: [],
    });

    const content = readFileSync(testPath, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.params.length).toBeLessThan(600);
    expect(entry.params).toContain("...(truncated)");
  });

  it("writes multiple entries as separate lines", () => {
    writeAuditEntry({
      timestamp: "2026-01-01T00:00:00Z",
      toolName: "tool1",
      params: "{}",
      blocked: false,
      findings: [],
    });
    writeAuditEntry({
      timestamp: "2026-01-01T00:00:01Z",
      toolName: "tool2",
      params: "{}",
      blocked: true,
      blockReason: "dangerous",
      findings: [{ ruleId: "rm-recursive", message: "rm -rf detected" }],
    });

    const lines = readFileSync(testPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]).blocked).toBe(true);
  });
});
