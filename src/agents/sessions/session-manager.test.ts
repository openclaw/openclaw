import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "./session-manager.js";
import type { SessionHeader } from "./session-manager.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-mgr-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── loadEntriesFromFile ────────────────────────────────────────────

describe("loadEntriesFromFile", () => {
  it("loads a normal file with header and messages", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      [
        '{"type":"session","version":2,"id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello"}}',
        '{"type":"message","id":"r1","parentId":"m1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":"hi"}}',
      ].join("\n"),
    );

    const entries = loadEntriesFromFile(file);
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe("session");
    expect((entries[0] as SessionHeader).id).toBe("s1");
    expect(entries[1].type).toBe("message");
    expect(entries[2].type).toBe("message");
  });

  it("preserves messages when header line is truncated (corruption)", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "corrupt.jsonl");
    // Simulate a crash-partial-write: header line is truncated mid-JSON
    fs.writeFileSync(
      file,
      [
        '{"type":"session","id":"s1","ver', // ← truncated, unparseable
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"important question"}}',
        '{"type":"message","id":"r1","parentId":"m1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":"valuable answer"}}',
      ].join("\n"),
    );

    const entries = loadEntriesFromFile(file);
    // 2 messages survived, no session entry
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("message");
    expect(entries[1].type).toBe("message");
    // Verify actual content is preserved
    expect((entries[0] as any).message.content).toBe("important question");
    expect((entries[1] as any).message.content).toBe("valuable answer");
  });

  it("returns empty array for an empty file", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "empty.jsonl");
    fs.writeFileSync(file, "");

    expect(loadEntriesFromFile(file)).toEqual([]);
  });

  it("moves header to index 0 when it is not the first valid parsed entry", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "shifted.jsonl");
    // Garbage line first, then a valid session header, then a message
    fs.writeFileSync(
      file,
      [
        "garbage line that will not parse",
        '{"type":"session","version":2,"id":"s4","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}',
        '{"type":"message","id":"m2","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello"}}',
      ].join("\n"),
    );

    const entries = loadEntriesFromFile(file);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("session");
    expect((entries[0] as SessionHeader).id).toBe("s4");
    expect(entries[1].type).toBe("message");
  });

  it("skips a session entry with a missing/invalid id", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "bad-header.jsonl");
    fs.writeFileSync(
      file,
      [
        '{"type":"session","version":2}', // no "id" field
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello"}}',
      ].join("\n"),
    );

    const entries = loadEntriesFromFile(file);
    // The session entry is present but has no valid id, so it is not
    // recognized as the session header — both entries are returned as-is.
    // Callers (like setSessionFile) handle this by synthesizing a new header.
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("session");
    expect(entries[1].type).toBe("message");
  });

  it("returns empty if the file does not exist", () => {
    expect(loadEntriesFromFile("/nonexistent/path.jsonl")).toEqual([]);
  });
});

// ── SessionManager recovery from corrupt header ────────────────────

describe("SessionManager corrupt-header recovery", () => {
  it("synthesizes a header and preserves messages when recovering from a corrupted session", () => {
    const dir = makeTempDir();
    const sessionFile = path.join(dir, "corrupt.jsonl");

    // Corrupted header + two valid messages
    fs.writeFileSync(
      sessionFile,
      [
        '{"type":"session","id":"orig","ver', // truncated, unparseable
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"important data"}}',
        '{"type":"message","id":"r1","parentId":"m1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":"also important"}}',
      ].join("\n"),
    );

    // Use persist=false so rewriteFile is a no-op — we only verify
    // the in-memory state after loading (header synthesis logic).
    const mgr = new SessionManager(
      "/tmp/test-cwd",
      dir,
      sessionFile,
      false, // persist = false
    );

    // A sessionId should be assigned (synthesized, not from the corrupt file)
    expect(mgr.sessionId).toBeDefined();
    expect(typeof mgr.sessionId).toBe("string");
    expect(mgr.sessionId.length).toBeGreaterThan(0);

    // fileEntries[0] should be the synthesized session header
    expect(mgr.fileEntries).toHaveLength(3);
    expect(mgr.fileEntries[0].type).toBe("session");
    const header = mgr.fileEntries[0] as SessionHeader;
    expect(header.id).toBe(mgr.sessionId);
    expect(header.type).toBe("session");

    // Messages should be preserved
    expect(mgr.fileEntries[1].type).toBe("message");
    expect((mgr.fileEntries[1] as any).message.content).toBe("important data");
    expect(mgr.fileEntries[2].type).toBe("message");
    expect((mgr.fileEntries[2] as any).message.content).toBe("also important");
  });

  it("starts fresh with an empty file", () => {
    const dir = makeTempDir();
    const sessionFile = path.join(dir, "empty.jsonl");
    fs.writeFileSync(sessionFile, "");

    const mgr = new SessionManager("/tmp/test-cwd", dir, sessionFile, false);

    // Empty file should result in a fresh session with one entry (the header)
    expect(mgr.fileEntries).toHaveLength(1);
    expect(mgr.fileEntries[0].type).toBe("session");
    expect(mgr.sessionId).toBeDefined();
  });

  it("loads a normal session file correctly (no regression)", () => {
    const dir = makeTempDir();
    const sessionFile = path.join(dir, "normal.jsonl");

    fs.writeFileSync(
      sessionFile,
      [
        '{"type":"session","version":2,"id":"mysession","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello"}}',
      ].join("\n"),
    );

    const mgr = new SessionManager("/tmp/test-cwd", dir, sessionFile, false);

    expect(mgr.sessionId).toBe("mysession");
    expect(mgr.fileEntries).toHaveLength(2);
    expect(mgr.fileEntries[0].type).toBe("session");
    expect(mgr.fileEntries[1].type).toBe("message");
  });
});
