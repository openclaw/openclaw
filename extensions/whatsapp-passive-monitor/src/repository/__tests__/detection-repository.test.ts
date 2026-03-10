import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DetectionRepositoryImpl, type DetectionRepository } from "../detection-repository.js";
import { SqliteRepositoryImpl, type SqliteRepository } from "../sqlite-repository.js";

describe("DetectionRepository", () => {
  let tmpDir: string;
  let sqliteRepo: SqliteRepository;
  let repo: DetectionRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wpm-det-repo-test-"));
    const dbPath = path.join(tmpDir, "messages.db");
    sqliteRepo = new SqliteRepositoryImpl(dbPath);
    repo = new DetectionRepositoryImpl(sqliteRepo);
  });

  afterEach(() => {
    sqliteRepo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- Schema creation ----

  it("creates the detections table on init (idempotent)", () => {
    // Re-creating on same DB should not error
    const repo2 = new DetectionRepositoryImpl(sqliteRepo);
    expect(repo2).toBeDefined();
  });

  // ---- Insert + retrieve ----

  it("inserts and returns the created detection row", () => {
    const result = repo.insertDetection({
      conversationId: "chat-1",
      detectionType: "add_calendar_event",
      windowMessageIds: [1, 2, 3],
    });

    expect(result.conversation_id).toBe("chat-1");
    expect(result.detection_type).toBe("add_calendar_event");
    expect(result.window_message_ids).toEqual([1, 2, 3]);
    expect(result.created).toBe(false);
    expect(result.id).toBeGreaterThan(0);
    expect(result.created_at).toBeGreaterThan(0);
  });

  it("returns the most recent detection", () => {
    repo.insertDetection({
      conversationId: "chat-1",
      detectionType: "add_calendar_event",
      windowMessageIds: [1, 2, 3],
    });
    repo.insertDetection({
      conversationId: "chat-1",
      detectionType: "confirm_with_customer",
      windowMessageIds: [4, 5, 6],
    });

    const result = repo.getLastDetection("chat-1");
    expect(result!.detection_type).toBe("confirm_with_customer");
    expect(result!.window_message_ids).toEqual([4, 5, 6]);
  });

  it("returns null when no detections exist", () => {
    const result = repo.getLastDetection("nonexistent");
    expect(result).toBeNull();
  });

  // ---- JSON round-trip ----

  it("round-trips window message IDs through JSON serialization", () => {
    const ids = [10, 20, 30, 40, 50];
    repo.insertDetection({
      conversationId: "chat-1",
      detectionType: "add_calendar_event",
      windowMessageIds: ids,
    });

    const result = repo.getLastDetection("chat-1");
    expect(result!.window_message_ids).toEqual(ids);
  });

  // ---- markCreated ----

  it("markCreated updates the detection by id", () => {
    const inserted = repo.insertDetection({
      conversationId: "chat-1",
      detectionType: "add_calendar_event",
      windowMessageIds: [1, 2, 3],
    });

    repo.markCreated(inserted.id);

    const result = repo.getLastDetection("chat-1");
    expect(result!.created).toBe(true);
  });

  // ---- deleteDetection ----

  it("deleteDetection removes the row by id", () => {
    const inserted = repo.insertDetection({
      conversationId: "chat-1",
      detectionType: "add_calendar_event",
      windowMessageIds: [1, 2, 3],
    });

    repo.deleteDetection(inserted.id);

    const result = repo.getLastDetection("chat-1");
    expect(result).toBeNull();
  });

  // ---- Isolation ----

  it("isolates conversations — query for chat-B returns null after inserting for chat-A", () => {
    repo.insertDetection({
      conversationId: "chat-A",
      detectionType: "add_calendar_event",
      windowMessageIds: [1, 2, 3],
    });

    const result = repo.getLastDetection("chat-B");
    expect(result).toBeNull();
  });
});
