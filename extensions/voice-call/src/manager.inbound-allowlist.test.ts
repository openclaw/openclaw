// Voice Call tests cover manager.inbound allowlist plugin behavior.
import { describe, expect, it } from "vitest";
import { FakeProvider, createManagerHarness } from "./manager.test-harness.js";

describe("CallManager inbound allowlist", () => {
  it.each([
    { label: "missing caller ID", from: undefined },
    { label: "anonymous caller ID", from: "anonymous" },
    { label: "an allowlist suffix", from: "+99915550001234" },
  ])("rejects inbound calls with $label", async ({ from }) => {
    const { manager, provider } = await createManagerHarness({
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });
    await manager.processEvent({
      id: "evt-allowlist-rejected",
      type: "call.initiated",
      callId: "call-rejected",
      providerCallId: "provider-rejected",
      timestamp: Date.now(),
      direction: "inbound",
      from,
      to: "+15550000000",
    });
    expect(manager.getCallByProviderCallId("provider-rejected")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(1);
    expect(provider.hangupCalls[0]?.providerCallId).toBe("provider-rejected");
  });

  it("rejects duplicate inbound events with a single hangup call", async () => {
    const { manager, provider } = await createManagerHarness({
      inboundPolicy: "disabled",
    });

    await manager.processEvent({
      id: "evt-reject-init",
      type: "call.initiated",
      callId: "provider-dup",
      providerCallId: "provider-dup",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15552222222",
      to: "+15550000000",
    });

    await manager.processEvent({
      id: "evt-reject-ring",
      type: "call.ringing",
      callId: "provider-dup",
      providerCallId: "provider-dup",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15552222222",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-dup")).toBeUndefined();
    expect(provider.hangupCalls).toEqual([
      { callId: "provider-dup", providerCallId: "provider-dup", reason: "hangup-bot" },
    ]);
  });

  it("retries rejected inbound hangup after a transient provider failure", async () => {
    class FlakyHangupProvider extends FakeProvider {
      hangupFailuresRemaining = 1;

      override async hangupCall(input: Parameters<FakeProvider["hangupCall"]>[0]): Promise<void> {
        this.hangupCalls.push(input);
        if (this.hangupFailuresRemaining > 0) {
          this.hangupFailuresRemaining -= 1;
          throw new Error("provider down");
        }
      }
    }

    const provider = new FlakyHangupProvider();
    const { manager } = await createManagerHarness(
      {
        inboundPolicy: "disabled",
      },
      provider,
    );

    await manager.processEvent({
      id: "evt-reject-fail-init",
      type: "call.initiated",
      callId: "provider-flaky",
      providerCallId: "provider-flaky",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15553333333",
      to: "+15550000000",
    });
    await Promise.resolve();

    await manager.processEvent({
      id: "evt-reject-fail-ring",
      type: "call.ringing",
      callId: "provider-flaky",
      providerCallId: "provider-flaky",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15553333333",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-flaky")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(2);
    expect(provider.hangupCalls.map((call) => call.providerCallId)).toEqual([
      "provider-flaky",
      "provider-flaky",
    ]);
  });

  it("accepts inbound calls that exactly match the allowlist", async () => {
    const { manager } = await createManagerHarness({
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });

    await manager.processEvent({
      id: "evt-allowlist-exact",
      type: "call.initiated",
      callId: "call-exact",
      providerCallId: "provider-exact",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15550001234",
      to: "+15550000000",
    });

    const call = manager.getCallByProviderCallId("provider-exact");
    if (!call) {
      throw new Error("expected exact allowlist match to keep the inbound call");
    }
    expect(call.providerCallId).toBe("provider-exact");
    expect(call.direction).toBe("inbound");
    expect(call.from).toBe("+15550001234");
    expect(call.to).toBe("+15550000000");
    expect(call.callId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
