import { describe, expect, it, vi } from "vitest";
import { NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR } from "./native-hook-relay-client.js";
import { verifyNativeHookRelayPreToolUseReadiness } from "./native-hook-relay-readiness.js";

const baseParams = {
  provider: "codex" as const,
  relayId: "relay-1",
  generation: "generation-1",
  readinessNonce: "readiness-1",
  sessionId: "session-1",
  nativeThreadId: "thread-1",
  turnId: "turn-1",
};

describe("native hook relay readiness transport", () => {
  it("recovers once, then proves the same guarded turn through the Gateway fallback", async () => {
    const directError = new Error("native hook relay bridge not found");
    const invokeBridge = vi.fn(async () => {
      throw directError;
    });
    const recover = vi.fn(async () => undefined);
    const invokeGateway = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(
      verifyNativeHookRelayPreToolUseReadiness({
        ...baseParams,
        recover,
        invokeBridge,
        invokeGateway,
      }),
    ).resolves.toBeUndefined();

    expect(invokeBridge).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledOnce();
    expect(invokeGateway).toHaveBeenCalledOnce();
    expect(invokeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        relayId: baseParams.relayId,
        generation: baseParams.generation,
        readinessNonce: baseParams.readinessNonce,
        event: "pre_tool_use",
        rawPayload: expect.objectContaining({
          session_id: baseParams.nativeThreadId,
          turn_id: baseParams.turnId,
        }),
      }),
    );
  });

  it("keeps stale registration rejection fail-closed without Gateway fallback", async () => {
    const invokeBridge = vi.fn(async () => {
      throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
    });
    const recover = vi.fn(async () => undefined);
    const invokeGateway = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(
      verifyNativeHookRelayPreToolUseReadiness({
        ...baseParams,
        recover,
        invokeBridge,
        invokeGateway,
      }),
    ).rejects.toThrow(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);

    expect(invokeBridge).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
    expect(invokeGateway).not.toHaveBeenCalled();
  });

  it("reports both transport components after one bounded recovery fails", async () => {
    const invokeBridge = vi.fn(async () => {
      throw new Error("direct listener unavailable");
    });
    const recover = vi.fn(async () => undefined);
    const invokeGateway = vi.fn(async () => {
      throw new Error("Gateway relay unavailable");
    });

    await expect(
      verifyNativeHookRelayPreToolUseReadiness({
        ...baseParams,
        recover,
        invokeBridge,
        invokeGateway,
      }),
    ).rejects.toThrow(
      "native hook relay readiness failed (direct bridge and gateway fallback): direct=direct listener unavailable; gateway=Gateway relay unavailable",
    );

    expect(invokeBridge).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledOnce();
    expect(invokeGateway).toHaveBeenCalledOnce();
  });
});
