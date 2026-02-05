import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallRecord } from "../types.js";
import { loadActiveCallsFromStore } from "./store.js";

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    provider: "twilio",
    direction: "outbound",
    state: "ringing",
    from: "+1111",
    to: "+2222",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    ...overrides,
  };
}

describe("loadActiveCallsFromStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-call-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty maps when no file exists", () => {
    const result = loadActiveCallsFromStore(tmpDir);
    expect(result.activeCalls.size).toBe(0);
  });

  it("loads non-terminal calls", () => {
    const call = makeCall({ state: "ringing" });
    fs.writeFileSync(path.join(tmpDir, "calls.jsonl"), JSON.stringify(call) + "\n");

    const result = loadActiveCallsFromStore(tmpDir);
    expect(result.activeCalls.size).toBe(1);
    expect(result.activeCalls.get("call-1")?.state).toBe("ringing");
  });

  it("skips terminal calls", () => {
    const call = makeCall({ state: "completed" });
    fs.writeFileSync(path.join(tmpDir, "calls.jsonl"), JSON.stringify(call) + "\n");

    const result = loadActiveCallsFromStore(tmpDir);
    expect(result.activeCalls.size).toBe(0);
  });

  it("discards stale calls when maxAgeMs is set", () => {
    const staleCall = makeCall({
      callId: "stale-1",
      state: "ringing",
      startedAt: Date.now() - 600_000, // 10 minutes ago
    });
    const freshCall = makeCall({
      callId: "fresh-1",
      state: "ringing",
      startedAt: Date.now() - 10_000, // 10 seconds ago
    });
    const lines = [JSON.stringify(staleCall), JSON.stringify(freshCall)].join("\n") + "\n";
    fs.writeFileSync(path.join(tmpDir, "calls.jsonl"), lines);

    const result = loadActiveCallsFromStore(tmpDir, { maxAgeMs: 300_000 }); // 5 min TTL
    expect(result.activeCalls.size).toBe(1);
    expect(result.activeCalls.has("stale-1")).toBe(false);
    expect(result.activeCalls.has("fresh-1")).toBe(true);
  });

  it("keeps all non-terminal calls when maxAgeMs is not set", () => {
    const oldCall = makeCall({
      callId: "old-1",
      state: "ringing",
      startedAt: Date.now() - 3_600_000, // 1 hour ago
    });
    fs.writeFileSync(path.join(tmpDir, "calls.jsonl"), JSON.stringify(oldCall) + "\n");

    const result = loadActiveCallsFromStore(tmpDir);
    expect(result.activeCalls.size).toBe(1);
  });
});
