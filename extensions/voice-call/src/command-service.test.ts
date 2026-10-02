import { describe, expect, it, vi } from "vitest";
import { createVoiceCallCommandService } from "./command-service.js";
import type { VoiceCallRuntime } from "./runtime.js";
import type { CallRecord } from "./types.js";

describe("voice call command service realtime control", () => {
  it("binds steering to the requester and active call, and keeps guidance for consults", async () => {
    const call: CallRecord = {
      callId: "call-1",
      provider: "mock",
      direction: "outbound",
      state: "active",
      from: "+15550001111",
      to: "+15550002222",
      startedAt: 0,
      transcript: [],
      processedEventIds: [],
      metadata: { requesterSessionKey: "agent:main:owner" },
    };
    const speakRealtime = vi.fn(() => ({ success: true }));
    const updateCallMetadata = vi.fn(async (_call, update, options) => {
      options?.assertCurrent?.();
      call.metadata = update(call.metadata);
    });
    const runtime = {
      config: { realtime: { enabled: true } },
      manager: {
        getCall: (id: string) => (id === call.callId ? call : undefined),
        updateCallMetadata,
      },
      webhookServer: { speakRealtime },
    } as unknown as VoiceCallRuntime;
    const commands = createVoiceCallCommandService(async () => runtime);
    await expect(
      commands.steer({
        callId: "call-1",
        message: "Ask for Tuesday",
        requesterSessionKey: "agent:main:stranger",
      }),
    ).rejects.toThrow("requester");
    await expect(
      commands.steer({
        callId: "call-2",
        message: "Ask for Tuesday",
        requesterSessionKey: "agent:main:owner",
      }),
    ).rejects.toThrow("active");
    expect(speakRealtime).not.toHaveBeenCalled();
    await expect(
      commands.steer({
        callId: "call-1",
        message: "Ask for Tuesday",
        requesterSessionKey: "agent:main:owner",
        mode: "guidance",
      }),
    ).resolves.toEqual({ success: true });
    expect(call.metadata?.ownerInstructions).toEqual(["Ask for Tuesday"]);
    expect(speakRealtime).toHaveBeenCalledWith(
      "call-1",
      expect.stringContaining("Ask for Tuesday"),
    );
    call.state = "completed";
    await expect(
      commands.steer({ callId: "call-1", message: "Too late", operator: true }),
    ).rejects.toThrow("active");
    expect(speakRealtime).toHaveBeenCalledTimes(1);
  });
});
