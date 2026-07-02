// Voice Call tests cover store plugin behavior.
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
  writeLegacyCallsJsonl,
} from "../manager.test-harness.js";
import { clearVoiceCallStateRuntime, setVoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema } from "../types.js";
import {
  flushPendingCallRecordWritesForTest,
  getCallHistoryFromStore,
  getPersistedCallByCallId,
  getPersistedCallByProviderCallId,
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
      openChannelIngressQueue: (() => {
        throw new Error("openChannelIngressQueue is not used by voice-call store tests");
      }) as never,
    },
  });
}

describe("voice-call call record store", () => {

  it("finds a persisted call record by call id (fallback for #96586)", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-by-id", providerCallId: "SID-by-id" }),
    );
    persistCallRecord(storePath, call);
    await flushPendingCallRecordWritesForTest();

    const found = await getPersistedCallByCallId(storePath, "call-by-id");
    expect(found?.callId).toBe("call-by-id");
  });

  it("returns null when no persisted call matches the call id", async () => {
    const storePath = createTestStorePath();
    const found = await getPersistedCallByCallId(storePath, "missing-call-id");
    expect(found).toBeNull();
  });

  it("finds a persisted call record by provider call id (fallback for #96586)", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-by-provider", providerCallId: "SID-by-provider" }),
    );
    persistCallRecord(storePath, call);
    await flushPendingCallRecordWritesForTest();

    const found = await getPersistedCallByProviderCallId(storePath, "SID-by-provider");
    expect(found?.providerCallId).toBe("SID-by-provider");
  });

  it("returns null when no persisted call matches the provider call id", async () => {
    const storePath = createTestStorePath();
    const found = await getPersistedCallByProviderCallId(storePath, "missing-sid");
    expect(found).toBeNull();
  });

  beforeEach(() => {
    resetPluginStateStoreForTests();
    installStateRuntime();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearVoiceCallStateRuntime();
    resetPluginStateStoreForTests();
  });

  it("does not import legacy JSONL records at runtime", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-legacy", processedEventIds: ["evt-1"] }),
    );
    writeLegacyCallsJsonl(storePath, [call]);

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.has("call-legacy")).toBe(false);
    expect(restored.processedEventIds.has("evt-1")).toBe(false);
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(true);

    const history = await getCallHistoryFromStore(storePath);
    expect(history).toEqual([]);
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

  it("does not read the JSONL fallback when SQLite state cannot open", () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(makePersistedCall({ callId: "call-jsonl" }));
    writeLegacyCallsJsonl(storePath, [call]);
    setVoiceCallStateRuntime({
      state: {
        resolveStateDir: () => "",
        openKeyedStore: (() => {
          throw new Error("openKeyedStore is not used by voice-call store tests");
        }) as never,
        openSyncKeyedStore: (() => {
          throw new Error("sqlite unavailable");
        }) as never,
        openChannelIngressQueue: (() => {
          throw new Error("openChannelIngressQueue is not used by voice-call store tests");
        }) as never,
      },
    });

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.has("call-jsonl")).toBe(false);
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(true);
  });

  it("persists oversized records in SQLite without creating a JSONL fallback", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({
        callId: "call-large",
        metadata: { mode: "conversation", numberRouteKey: "+15550000001" },
        transcript: [
          {
            timestamp: Date.now(),
            speaker: "user",
            text: "x".repeat(3 * 1024 * 1024),
            isFinal: true,
          },
        ],
      }),
    );

    persistCallRecord(storePath, call);
    await flushPendingCallRecordWritesForTest();

    const restored = loadActiveCallsFromStore(storePath);
    const restoredCall = restored.activeCalls.get("call-large");
    expect(restoredCall?.providerCallId).toBe(call.providerCallId);
    expect(restoredCall?.transcript).toEqual([]);
    expect(restoredCall?.metadata).toMatchObject({
      mode: "conversation",
      numberRouteKey: "+15550000001",
      voiceCallPersistence: { transcriptTruncated: true },
    });
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(false);
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
