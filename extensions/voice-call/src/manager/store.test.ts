import fs from "node:fs";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestStorePath,
  makePersistedCall,
  writeCallsToStore,
} from "../manager.test-harness.js";
import { clearVoiceCallStateRuntime, setVoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema } from "../types.js";
import {
  flushPendingCallRecordWritesForTest,
  getCallHistoryFromStore,
  loadActiveCallsFromStore,
  persistCallRecord,
} from "./store.js";

function installStateRuntime(): void {
  setVoiceCallStateRuntime({
    state: {
      resolveStateDir: () => "",
      openKeyedStore: (() => {
        throw new Error("openKeyedStore is not used by voice-call store tests");
      }) as never,
      openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests("voice-call", options),
    },
  });
}

describe("voice-call call record store", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installStateRuntime();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearVoiceCallStateRuntime();
    resetPluginStateStoreForTests();
  });

  it("migrates legacy JSONL records into SQLite-backed plugin state", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-legacy", processedEventIds: ["evt-1"] }),
    );
    writeCallsToStore(storePath, [call]);

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.get("call-legacy")?.providerCallId).toBe(call.providerCallId);
    expect(restored.processedEventIds.has("evt-1")).toBe(true);
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(storePath, "state", "openclaw.sqlite"))).toBe(true);

    const history = await getCallHistoryFromStore(storePath);
    expect(history).toHaveLength(1);
    expect(history[0]?.callId).toBe("call-legacy");
  });

  it("persists new call snapshots without recreating the JSONL log", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-sqlite", transcript: [] }),
    );

    persistCallRecord(storePath, call);
    await flushPendingCallRecordWritesForTest();

    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(false);
    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.get("call-sqlite")?.providerCallId).toBe(call.providerCallId);
  });

  it("imports fallback JSONL writes created after the migration marker", async () => {
    const storePath = createTestStorePath();
    const sqliteCall = CallRecordSchema.parse(makePersistedCall({ callId: "call-sqlite" }));
    const fallbackCall = CallRecordSchema.parse(makePersistedCall({ callId: "call-fallback" }));

    persistCallRecord(storePath, sqliteCall);
    writeCallsToStore(storePath, [fallbackCall]);

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.has("call-sqlite")).toBe(true);
    expect(restored.activeCalls.get("call-fallback")?.providerCallId).toBe(
      fallbackCall.providerCallId,
    );
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(false);
  });

  it("reads the JSONL fallback when SQLite state cannot open", () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(makePersistedCall({ callId: "call-jsonl" }));
    writeCallsToStore(storePath, [call]);
    setVoiceCallStateRuntime({
      state: {
        resolveStateDir: () => "",
        openKeyedStore: (() => {
          throw new Error("openKeyedStore is not used by voice-call store tests");
        }) as never,
        openSyncKeyedStore: (() => {
          throw new Error("sqlite unavailable");
        }) as never,
      },
    });

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.get("call-jsonl")?.providerCallId).toBe(call.providerCallId);
  });

  it("keeps oversized fallback records readable when they exceed SQLite chunk budget", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({
        callId: "call-large",
        transcript: [
          {
            timestamp: Date.now(),
            speaker: "user",
            text: "x".repeat(2 * 1024 * 1024),
            isFinal: true,
          },
        ],
      }),
    );

    persistCallRecord(storePath, call);
    await flushPendingCallRecordWritesForTest();

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.get("call-large")?.providerCallId).toBe(call.providerCallId);
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(true);
  });

  it("does not let an older fallback record override a newer SQLite snapshot", async () => {
    const storePath = createTestStorePath();
    const olderFallback = CallRecordSchema.parse(
      makePersistedCall({
        callId: "call-mixed",
        state: "answered",
        transcript: [
          {
            timestamp: Date.now(),
            speaker: "user",
            text: "x".repeat(2 * 1024 * 1024),
            isFinal: true,
          },
        ],
      }),
    );
    const newerSqlite = CallRecordSchema.parse(
      makePersistedCall({
        callId: "call-mixed",
        state: "completed",
        endedAt: Date.now(),
        endReason: "completed",
      }),
    );

    persistCallRecord(storePath, olderFallback);
    await flushPendingCallRecordWritesForTest();
    persistCallRecord(storePath, newerSqlite);

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.has("call-mixed")).toBe(false);
  });

  it("replays same-millisecond snapshots in write order", () => {
    vi.useFakeTimers({ now: new Date("2026-05-31T10:00:00.000Z") });
    const storePath = createTestStorePath();
    const first = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-order", state: "ringing" }),
    );
    const second = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-order", state: "answered" }),
    );

    persistCallRecord(storePath, first);
    persistCallRecord(storePath, second);

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.get("call-order")?.state).toBe("answered");
  });
});
