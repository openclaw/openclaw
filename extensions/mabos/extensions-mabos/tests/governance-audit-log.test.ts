import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/governance/audit-log.js";

function tempDb(): string {
  return join(tmpdir(), `audit-test-${randomUUID()}.sqlite`);
}

describe("AuditLog", () => {
  const dbs: string[] = [];
  const logs: AuditLog[] = [];

  function createLog(): AuditLog {
    const path = tempDb();
    dbs.push(path);
    const log = new AuditLog(path);
    logs.push(log);
    return log;
  }

  afterEach(() => {
    for (const l of logs) {
      try {
        l.close();
      } catch {
        // already closed
      }
    }
    logs.length = 0;
    for (const p of dbs) {
      try {
        unlinkSync(p);
      } catch {
        // ok
      }
      try {
        unlinkSync(p + "-wal");
      } catch {
        // ok
      }
      try {
        unlinkSync(p + "-shm");
      } catch {
        // ok
      }
    }
    dbs.length = 0;
  });

  it("logs and queries audit entries", () => {
    const log = createLog();

    log.log({
      actorType: "agent",
      actorId: "agent-1",
      action: "tool.execute",
      resourceType: "tool",
      resourceId: "shopify-create-product",
      outcome: "success",
    });

    log.log({
      actorType: "operator",
      actorId: "user-1",
      action: "budget.update",
      outcome: "success",
    });

    const entries = log.query();
    expect(entries).toHaveLength(2);
    // Ordered by id DESC, so newest first
    expect(entries[0].action).toBe("budget.update");
    expect(entries[1].action).toBe("tool.execute");
    expect(entries[1].resourceId).toBe("shopify-create-product");
  });

  it("filters by action", () => {
    const log = createLog();

    log.log({
      actorType: "agent",
      actorId: "agent-1",
      action: "tool.execute",
      outcome: "success",
    });
    log.log({
      actorType: "agent",
      actorId: "agent-1",
      action: "budget.check",
      outcome: "success",
    });
    log.log({
      actorType: "operator",
      actorId: "user-1",
      action: "tool.execute",
      outcome: "denied",
    });

    const toolEntries = log.query({ action: "tool.execute" });
    expect(toolEntries).toHaveLength(2);
    for (const e of toolEntries) {
      expect(e.action).toBe("tool.execute");
    }
  });

  it("filters by time range", () => {
    const log = createLog();

    // Insert entries with explicit timestamps via direct SQL is tricky,
    // so we insert entries and filter by the auto-generated timestamps
    log.log({
      actorType: "system",
      actorId: "cron",
      action: "cleanup",
      outcome: "success",
    });

    // Query with a time range that includes now
    const now = new Date();
    const from = new Date(now.getTime() - 60_000).toISOString().replace("T", " ").slice(0, 19);
    const to = new Date(now.getTime() + 60_000).toISOString().replace("T", " ").slice(0, 19);

    const inRange = log.query({ from, to });
    expect(inRange).toHaveLength(1);
    expect(inRange[0].action).toBe("cleanup");

    // Query with a time range in the past (should return nothing)
    const pastFrom = "2020-01-01 00:00:00";
    const pastTo = "2020-01-02 00:00:00";
    const outOfRange = log.query({ from: pastFrom, to: pastTo });
    expect(outOfRange).toHaveLength(0);
  });
});
