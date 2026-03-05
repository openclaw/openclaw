import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AuditLogger, type AuditEntry } from "./audit.js";

describe("AuditLogger", () => {
  let tmpDir: string;
  let logPath: string;
  let logger: AuditLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-audit-"));
    logPath = path.join(tmpDir, "harness-audit.jsonl");
    logger = new AuditLogger(logPath);
  });

  afterEach(() => {
    logger.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a valid JSONL entry", async () => {
    await logger.log({
      tool: "email.send",
      argsSummary: "to: alice@example.com",
      tier: "allow",
      tainted: false,
      result: "executed",
      chainFlags: [],
      rateWindow: { write: 7 },
    });

    const content = fs.readFileSync(logPath, "utf-8").trim();
    const entry = JSON.parse(content) as AuditEntry;
    expect(entry.tool).toBe("email.send");
    expect(entry.tier).toBe("allow");
    expect(entry.ts).toBeTruthy();
  });

  it("appends multiple entries", async () => {
    await logger.log({
      tool: "a",
      argsSummary: "",
      tier: "allow",
      tainted: false,
      result: "executed",
      chainFlags: [],
      rateWindow: {},
    });
    await logger.log({
      tool: "b",
      argsSummary: "",
      tier: "block",
      tainted: false,
      result: "denied",
      chainFlags: [],
      rateWindow: {},
    });

    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).tool).toBe("a");
    expect(JSON.parse(lines[1]).tool).toBe("b");
  });

  it("creates parent directory if missing", async () => {
    const nestedPath = path.join(tmpDir, "sub", "dir", "audit.jsonl");
    const nestedLogger = new AuditLogger(nestedPath);
    await nestedLogger.log({
      tool: "x",
      argsSummary: "",
      tier: "allow",
      tainted: false,
      result: "executed",
      chainFlags: [],
      rateWindow: {},
    });
    nestedLogger.close();

    expect(fs.existsSync(nestedPath)).toBe(true);
  });
});
