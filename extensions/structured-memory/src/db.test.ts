import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmpDir = path.join(os.tmpdir(), `sm-db-test-${Date.now()}`);

vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: () => tmpDir,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-storage", () => ({
  requireNodeSqlite: () => ({ DatabaseSync }),
}));

import {
  getOrOpenDatabase,
  insertRecord,
  updateRecord,
  findRecords,
  findRecordById,
  recordExists,
  findConflictingRecords,
  archiveRecord,
  scanExpiredRecords,
  scanAllActiveRecords,
  touchAccessTime,
  closeAllDatabases,
} from "./db";

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, "structured-memory"), { recursive: true });
});

afterAll(() => {
  closeAllDatabases();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // reset: delete and recreate db for isolation
  closeAllDatabases();
  const dbDir = path.join(tmpDir, "structured-memory");
  if (fs.existsSync(dbDir)) {
    for (const f of fs.readdirSync(dbDir)) {
      fs.unlinkSync(path.join(dbDir, f));
    }
  }
});

describe("insertRecord", () => {
  it("inserts a record with generated id", () => {
    const db = getOrOpenDatabase("test-agent");
    const id = insertRecord(db, {
      type: "fact",
      summary: "hello world",
      importance: 5,
      keywords: "hello world",
      agent_id: "test-agent",
    });
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("inserts with explicit id", () => {
    const db = getOrOpenDatabase("test-agent");
    const id = insertRecord(db, {
      id: "custom-001",
      type: "event",
      summary: "custom event",
      importance: 7,
      keywords: "custom event",
      agent_id: "test-agent",
    });
    expect(id).toBe("custom-001");
  });

  it("defaults confidence to 0.3", () => {
    const db = getOrOpenDatabase("test-agent");
    const id = insertRecord(db, {
      type: "fact",
      summary: "no confidence",
      importance: 3,
      keywords: "test",
      agent_id: "test-agent",
    });
    const record = findRecordById(db, id);
    expect(record?.confidence).toBe(0.3);
  });

  it("computes initial salience from importance", () => {
    const db = getOrOpenDatabase("test-agent");
    const id = insertRecord(db, {
      type: "fact",
      summary: "importance 10",
      importance: 10,
      keywords: "test",
      agent_id: "test-agent",
    });
    const record = findRecordById(db, id);
    expect(record?.salience).toBeCloseTo(1.0, 1);
  });

  it("defaults status to active", () => {
    const db = getOrOpenDatabase("test-agent");
    const id = insertRecord(db, {
      type: "fact",
      summary: "status test",
      importance: 5,
      keywords: "test",
      agent_id: "test-agent",
    });
    const record = findRecordById(db, id);
    expect(record?.status).toBe("active");
  });
});

describe("updateRecord", () => {
  it("updates summary and importance", () => {
    const db = getOrOpenDatabase("test-agent");
    const id = insertRecord(db, {
      type: "fact",
      summary: "original",
      importance: 3,
      keywords: "original",
      agent_id: "test-agent",
    });
    const ok = updateRecord(db, id, { summary: "updated", importance: 8 });
    expect(ok).toBe(true);
    const record = findRecordById(db, id);
    expect(record?.summary).toBe("updated");
    expect(record?.importance).toBe(8);
  });

  it("updates critical and activate_at", () => {
    const db = getOrOpenDatabase("test-agent");
    const id = insertRecord(db, {
      type: "fact",
      summary: "critical test",
      importance: 5,
      keywords: "test",
      agent_id: "test-agent",
    });
    const ok = updateRecord(db, id, {
      critical: 1,
      activate_at: "2027-01-01T00:00:00.000Z",
    });
    expect(ok).toBe(true);
    const record = findRecordById(db, id);
    expect(record?.critical).toBe(1);
    expect(record?.activate_at).toBe("2027-01-01T00:00:00.000Z");
  });

  it("returns false for non-existent id", () => {
    const db = getOrOpenDatabase("test-agent");
    expect(updateRecord(db, "no-such-id", { summary: "nope" })).toBe(false);
  });
});

describe("findRecords", () => {
  it("filters by status", () => {
    const db = getOrOpenDatabase("test-agent");
    insertRecord(db, {
      type: "fact",
      summary: "active record",
      importance: 5,
      keywords: "active",
      agent_id: "test-agent",
    });
    const results = findRecords(db, { status: "active" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.status === "active")).toBe(true);
  });

  it("filters by type", () => {
    const db = getOrOpenDatabase("test-agent");
    insertRecord(db, {
      type: "rule",
      summary: "a rule",
      importance: 8,
      keywords: "rule",
      agent_id: "test-agent",
    });
    insertRecord(db, {
      type: "fact",
      summary: "a fact",
      importance: 5,
      keywords: "fact",
      agent_id: "test-agent",
    });
    const results = findRecords(db, { type: ["rule"] });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.type === "rule")).toBe(true);
  });

  it("filters by importance_min", () => {
    const db = getOrOpenDatabase("test-agent");
    insertRecord(db, {
      type: "fact",
      summary: "low",
      importance: 2,
      keywords: "low",
      agent_id: "test-agent",
    });
    insertRecord(db, {
      type: "fact",
      summary: "high",
      importance: 9,
      keywords: "high",
      agent_id: "test-agent",
    });
    const results = findRecords(db, { importance_min: 8 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.importance >= 8)).toBe(true);
  });

  it("filters by confidence_min", () => {
    const db = getOrOpenDatabase("test-agent");
    insertRecord(db, {
      type: "fact",
      summary: "confident",
      importance: 5,
      confidence: 0.9,
      keywords: "test",
      agent_id: "test-agent",
    });
    const results = findRecords(db, { confidence_min: 0.8 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.confidence >= 0.8)).toBe(true);
  });

  it("filters by keywords_contains", () => {
    const db = getOrOpenDatabase("test-agent");
    insertRecord(db, {
      type: "fact",
      summary: "keyword test",
      importance: 5,
      keywords: "杭州 跑步",
      agent_id: "test-agent",
    });
    const results = findRecords(db, { keywords_contains: "杭州" });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("limits results", () => {
    const db = getOrOpenDatabase("test-agent");
    for (let i = 0; i < 5; i++) {
      insertRecord(db, {
        type: "fact",
        summary: `record ${i}`,
        importance: 5,
        keywords: "test",
        agent_id: "test-agent",
      });
    }
    const results = findRecords(db, { max_results: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("archiveRecord", () => {
  it("sets status to archived", () => {
    const db = getOrOpenDatabase("test-agent");
    const id = insertRecord(db, {
      type: "fact",
      summary: "to archive",
      importance: 3,
      keywords: "test",
      agent_id: "test-agent",
    });
    const ok = archiveRecord(db, id, "test reason");
    expect(ok).toBe(true);
    const record = findRecordById(db, id);
    expect(record?.status).toBe("archived");
  });

  it("returns false for non-existent id", () => {
    const db = getOrOpenDatabase("test-agent");
    expect(archiveRecord(db, "no-such-id", "reason")).toBe(false);
  });

  it("stores archive reason in attributes", () => {
    const db = getOrOpenDatabase("test-agent");
    const id = insertRecord(db, {
      type: "fact",
      summary: "reason test",
      importance: 3,
      keywords: "test",
      agent_id: "test-agent",
    });
    archiveRecord(db, id, "decayed");
    const record = findRecordById(db, id);
    const attrs = JSON.parse(record?.attributes ?? "{}");
    expect(attrs._archive_reason).toBe("decayed");
  });
});

describe("findConflictingRecords", () => {
  it("detects records with same type and overlapping keywords", () => {
    const db = getOrOpenDatabase("test-agent");
    insertRecord(db, {
      type: "preference",
      summary: "likes pizza",
      importance: 5,
      keywords: "pizza food italian dinner",
      agent_id: "test-agent",
    });
    insertRecord(db, {
      type: "preference",
      summary: "dislikes pizza",
      importance: 5,
      keywords: "pizza food hate dinner",
      agent_id: "test-agent",
    });
    const conflicts = findConflictingRecords(
      db,
      "preference",
      "pizza food dinner menu",
      "test-agent",
    );
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for < 3 keyword terms", () => {
    const db = getOrOpenDatabase("test-agent");
    insertRecord(db, {
      type: "fact",
      summary: "test",
      importance: 5,
      keywords: "hello",
      agent_id: "test-agent",
    });
    const conflicts = findConflictingRecords(db, "fact", "hello", "test-agent");
    expect(conflicts.length).toBe(0);
  });

  it("filters by agent_id when provided", () => {
    const db = getOrOpenDatabase("test-agent");
    insertRecord(db, {
      type: "fact",
      summary: "agent A",
      importance: 5,
      keywords: "alpha beta gamma delta",
      agent_id: "agent-a",
    });
    const conflicts = findConflictingRecords(db, "fact", "alpha beta gamma delta", "test-agent");
    expect(conflicts.length).toBe(0);
  });
});

describe("scanExpiredRecords", () => {
  it("returns records with past expire_at", () => {
    const db = getOrOpenDatabase("test-agent");
    const id = insertRecord(db, {
      type: "fact",
      summary: "expired",
      importance: 3,
      keywords: "test",
      agent_id: "test-agent",
      expire_at: "2020-01-01T00:00:00.000Z",
    });
    const expired = scanExpiredRecords(db);
    const ids = expired.map((r) => r.id);
    expect(ids).toContain(id);
  });
});

describe("touchAccessTime", () => {
  it("sets last_accessed_at for specified ids", () => {
    const db = getOrOpenDatabase("test-agent");
    const id = insertRecord(db, {
      type: "fact",
      summary: "access test",
      importance: 5,
      keywords: "test",
      agent_id: "test-agent",
    });
    const before = findRecordById(db, id);
    expect(before?.last_accessed_at).toBeNull();
    touchAccessTime(db, [id]);
    const after = findRecordById(db, id);
    expect(after?.last_accessed_at).toBeTruthy();
  });
});
