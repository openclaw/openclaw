import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLogger } from "./audit-logger.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "sg-al-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("AuditLogger", () => {
  it("creates directory and writes JSONL lines", () => {
    const dir = makeTmpDir();
    const logPath = path.join(dir, "sub", "audit.jsonl");
    const logger = new AuditLogger(logPath);
    logger.init();

    logger.record({ event: "config_sync", detail: "version=v1" });
    logger.record({ event: "blocked", skill: "evil", reason: "blocklisted" });
    logger.record({ event: "load_pass", skill: "good", source: "store" });
    logger.close();

    const lines = fsSync.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);

    const rec0 = JSON.parse(lines[0]);
    expect(rec0.event).toBe("config_sync");
    expect(rec0.detail).toBe("version=v1");
    expect(rec0.ts).toBeTruthy();

    const rec1 = JSON.parse(lines[1]);
    expect(rec1.event).toBe("blocked");
    expect(rec1.skill).toBe("evil");
    expect(rec1.reason).toBe("blocklisted");
  });

  it("does nothing when disabled", () => {
    const dir = makeTmpDir();
    const logPath = path.join(dir, "audit.jsonl");
    const logger = new AuditLogger(logPath, false);
    logger.init();
    logger.record({ event: "config_sync" });
    logger.close();

    expect(fsSync.existsSync(logPath)).toBe(false);
  });

  it("survives double close", () => {
    const dir = makeTmpDir();
    const logPath = path.join(dir, "audit.jsonl");
    const logger = new AuditLogger(logPath);
    logger.init();
    logger.close();
    logger.close(); // should not throw
  });
});
