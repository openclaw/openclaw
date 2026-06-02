import { describe, expect, it, vi } from "vitest";

const { persistCallRecordMock } = vi.hoisted(() => ({
  persistCallRecordMock: vi.fn(),
}));

vi.mock("./store.js", () => ({
  persistCallRecord: persistCallRecordMock,
}));

import type { CallRecord } from "../types.js";
import { finalizeCall } from "./lifecycle.js";

function createCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    providerCallId: "provider-1",
    provider: "twilio",
    direction: "outbound",
    state: "active",
    from: "+15550000000",
    to: "+15550000001",
    startedAt: 1,
    transcript: [],
    processedEventIds: [],
    ...overrides,
  };
}

describe("voice-call manager lifecycle", () => {
  it("finalizes calls without removing provider ids owned by repaired calls", () => {
    const call = createCall();
    const activeCalls = new Map([["call-1", call]]);
    const providerCallIdMap = new Map([["provider-1", "call-2"]]);

    finalizeCall({
      ctx: {
        activeCalls,
        providerCallIdMap,
        storePath: "/tmp/voice-call",
      },
      call,
      endReason: "completed",
      endedAt: 42,
    });

    expect(call).toMatchObject({
      state: "completed",
      endReason: "completed",
      endedAt: 42,
    });
    expect(activeCalls.has("call-1")).toBe(false);
    expect(providerCallIdMap.get("provider-1")).toBe("call-2");
    expect(persistCallRecordMock).toHaveBeenCalledWith("/tmp/voice-call", call);
  });
});
