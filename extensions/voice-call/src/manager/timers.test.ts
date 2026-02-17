import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import type { CallRecord } from "../types.js";
import { startMaxDurationTimer } from "./timers.js";

function createCallRecord(): CallRecord {
  return {
    callId: "call-timeout",
    providerCallId: "provider-timeout",
    provider: "plivo",
    direction: "outbound",
    state: "active",
    from: "+15550000000",
    to: "+15550000001",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {},
  };
}

describe("startMaxDurationTimer", () => {
  it("still invokes timeout handler when persist fails", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const call = createCallRecord();
    const activeCalls = new Map([[call.callId, call]]);
    const maxDurationTimers = new Map<string, NodeJS.Timeout>();
    const onTimeout = vi.fn(async () => undefined);

    const ctx = {
      activeCalls,
      maxDurationTimers,
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        maxDurationSeconds: 1,
      }),
      storePath: path.join(
        os.tmpdir(),
        `openclaw-voice-call-timer-missing-${Date.now()}`,
        "missing",
      ),
    };

    try {
      startMaxDurationTimer({
        ctx,
        callId: call.callId,
        onTimeout: async (callId) => {
          await onTimeout(callId);
        },
      });

      await vi.advanceTimersByTimeAsync(1100);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith(call.callId);
      expect(call.endReason).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("logs and continues when persistence throws synchronously", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const call = createCallRecord();
    const activeCalls = new Map([[call.callId, call]]);
    const maxDurationTimers = new Map<string, NodeJS.Timeout>();
    const onTimeout = vi.fn(async () => undefined);

    const ctx = {
      activeCalls,
      maxDurationTimers,
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        maxDurationSeconds: 1,
      }),
      storePath: fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-voice-call-timer-test-")),
    };

    const originalAppendFileSync = fs.appendFileSync;
    const appendSpy = vi.spyOn(fs, "appendFileSync").mockImplementation(
      (() => {
        throw new Error("disk full");
      }) as typeof fs.appendFileSync,
    );

    try {
      startMaxDurationTimer({
        ctx,
        callId: call.callId,
        onTimeout: async (callId) => {
          await onTimeout(callId);
        },
      });

      await vi.advanceTimersByTimeAsync(1100);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith(call.callId);
      expect(call.endReason).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      appendSpy.mockImplementation(originalAppendFileSync);
      appendSpy.mockRestore();
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
