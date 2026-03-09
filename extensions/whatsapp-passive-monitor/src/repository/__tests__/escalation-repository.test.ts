import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EscalationRepositoryImpl, type EscalationRepository } from "../escalation-repository.js";
import { SqliteRepositoryImpl, type SqliteRepository } from "../sqlite-repository.js";

describe("EscalationRepository", () => {
  let tmpDir: string;
  let sqliteRepo: SqliteRepository;
  let repo: EscalationRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wpm-esc-repo-test-"));
    const dbPath = path.join(tmpDir, "messages.db");
    sqliteRepo = new SqliteRepositoryImpl(dbPath);
    repo = new EscalationRepositoryImpl(sqliteRepo);
  });

  afterEach(() => {
    sqliteRepo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- Schema creation ----

  it("creates the escalations table on init (idempotent)", () => {
    // Re-creating on same DB should not error
    const repo2 = new EscalationRepositoryImpl(sqliteRepo);
    expect(repo2).toBeDefined();
  });

  // ---- Insert + retrieve ----

  it("inserts and retrieves an escalation", () => {
    repo.insertEscalation({
      conversationId: "chat-1",
      escalationType: "add_calendar_event",
      windowMessageIds: [1, 2, 3],
    });

    const result = repo.getLastEscalation("chat-1");
    expect(result).not.toBeNull();
    expect(result!.conversation_id).toBe("chat-1");
    expect(result!.escalation_type).toBe("add_calendar_event");
    expect(result!.created).toBe(false);
    expect(result!.id).toBeGreaterThan(0);
    expect(result!.created_at).toBeGreaterThan(0);
  });

  it("returns the most recent escalation", () => {
    repo.insertEscalation({
      conversationId: "chat-1",
      escalationType: "add_calendar_event",
      windowMessageIds: [1, 2, 3],
    });
    repo.insertEscalation({
      conversationId: "chat-1",
      escalationType: "confirm_with_customer",
      windowMessageIds: [4, 5, 6],
    });

    const result = repo.getLastEscalation("chat-1");
    expect(result!.escalation_type).toBe("confirm_with_customer");
    expect(result!.window_message_ids).toEqual([4, 5, 6]);
  });

  it("returns null when no escalations exist", () => {
    const result = repo.getLastEscalation("nonexistent");
    expect(result).toBeNull();
  });

  // ---- JSON round-trip ----

  it("round-trips window message IDs through JSON serialization", () => {
    const ids = [10, 20, 30, 40, 50];
    repo.insertEscalation({
      conversationId: "chat-1",
      escalationType: "add_calendar_event",
      windowMessageIds: ids,
    });

    const result = repo.getLastEscalation("chat-1");
    expect(result!.window_message_ids).toEqual(ids);
  });

  // ---- markCreated ----

  it("markCreated updates the latest uncreated escalation", () => {
    repo.insertEscalation({
      conversationId: "chat-1",
      escalationType: "add_calendar_event",
      windowMessageIds: [1, 2, 3],
    });

    repo.markCreated("chat-1");

    const result = repo.getLastEscalation("chat-1");
    expect(result!.created).toBe(true);
  });

  // ---- Isolation ----

  it("isolates conversations — query for chat-B returns null after inserting for chat-A", () => {
    repo.insertEscalation({
      conversationId: "chat-A",
      escalationType: "add_calendar_event",
      windowMessageIds: [1, 2, 3],
    });

    const result = repo.getLastEscalation("chat-B");
    expect(result).toBeNull();
  });
});
