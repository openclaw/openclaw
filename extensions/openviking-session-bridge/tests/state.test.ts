import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadCheckpoint, saveCheckpoint, markFinalized } from "../src/state.js";
import type { SessionCheckpoint } from "../src/types.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ov-state-test-"));
}

const SAMPLE: SessionCheckpoint = {
  openclawSessionId: "session-abc-123",
  sessionKey: "agent:main:telegram:group:1001:topic:2",
  agentId: "main",
  ovSessionId: "ov-xyz-456",
  lastFlushedIndex: 5,
  finalized: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("checkpoint store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for missing checkpoint", () => {
    expect(loadCheckpoint(tmpDir, "no-such-session")).toBeNull();
  });

  it("round-trips a checkpoint", () => {
    saveCheckpoint(tmpDir, SAMPLE);
    const loaded = loadCheckpoint(tmpDir, SAMPLE.openclawSessionId);
    expect(loaded).toMatchObject(SAMPLE);
  });

  it("overwrites an existing checkpoint", () => {
    saveCheckpoint(tmpDir, SAMPLE);
    const updated: SessionCheckpoint = { ...SAMPLE, lastFlushedIndex: 10 };
    saveCheckpoint(tmpDir, updated);
    const loaded = loadCheckpoint(tmpDir, SAMPLE.openclawSessionId);
    expect(loaded?.lastFlushedIndex).toBe(10);
  });

  it("creates stateDir if it does not exist", () => {
    const nested = path.join(tmpDir, "deep", "nested");
    expect(fs.existsSync(nested)).toBe(false);
    saveCheckpoint(nested, SAMPLE);
    expect(fs.existsSync(nested)).toBe(true);
    expect(loadCheckpoint(nested, SAMPLE.openclawSessionId)).not.toBeNull();
  });

  it("markFinalized sets finalized:true on an existing checkpoint", () => {
    saveCheckpoint(tmpDir, SAMPLE);
    markFinalized(tmpDir, SAMPLE.openclawSessionId);
    const loaded = loadCheckpoint(tmpDir, SAMPLE.openclawSessionId);
    expect(loaded?.finalized).toBe(true);
  });

  it("markFinalized is a no-op for missing session", () => {
    // Should not throw.
    markFinalized(tmpDir, "no-such-session");
  });

  it("rejects checkpoint with mismatched sessionId", () => {
    const filePath = path.join(tmpDir, "session-abc-123.json");
    fs.writeFileSync(filePath, JSON.stringify({ ...SAMPLE, openclawSessionId: "different-id" }));
    expect(loadCheckpoint(tmpDir, "session-abc-123")).toBeNull();
  });
});
