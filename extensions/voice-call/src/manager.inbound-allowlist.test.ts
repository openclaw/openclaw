import { describe, expect, it } from "vitest";
import { createManagerHarness } from "./manager.test-harness.js";

describe("CallManager inbound allowlist", () => {
  it("rejects inbound calls with missing caller ID when allowlist enabled", async () => {
    const { manager, provider } = await createManagerHarness({
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });

    manager.processEvent({
      id: "evt-allowlist-missing",
      type: "call.initiated",
      callId: "call-missing",
      providerCallId: "provider-missing",
      timestamp: Date.now(),
      direction: "inbound",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-missing")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(1);
    expect(provider.hangupCalls[0]?.providerCallId).toBe("provider-missing");
  });

  it("rejects inbound calls with anonymous caller ID when allowlist enabled", async () => {
    const { manager, provider } = await createManagerHarness({
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });

    manager.processEvent({
      id: "evt-allowlist-anon",
      type: "call.initiated",
      callId: "call-anon",
      providerCallId: "provider-anon",
      timestamp: Date.now(),
      direction: "inbound",
      from: "anonymous",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-anon")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(1);
    expect(provider.hangupCalls[0]?.providerCallId).toBe("provider-anon");
  });

  it("rejects inbound calls that only match allowlist suffixes", async () => {
    const { manager, provider } = await createManagerHarness({
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });

    manager.processEvent({
      id: "evt-allowlist-suffix",
      type: "call.initiated",
      callId: "call-suffix",
      providerCallId: "provider-suffix",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+99915550001234",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-suffix")).toBeUndefined();
    expect(provider.hangupCalls).toHaveLength(1);
    expect(provider.hangupCalls[0]?.providerCallId).toBe("provider-suffix");
  });

  it("rejects duplicate inbound events with a single hangup call", async () => {
    const { manager, provider } = await createManagerHarness({
      inboundPolicy: "disabled",
    });

    manager.processEvent({
      id: "evt-reject-init",
      type: "call.initiated",
      callId: "provider-dup",
      providerCallId: "provider-dup",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15552222222",
      to: "+15550000000",
    });

    manager.processEvent({
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
    expect(provider.hangupCalls).toHaveLength(1);
    expect(provider.hangupCalls[0]?.providerCallId).toBe("provider-dup");
  });

  it("accepts inbound calls that exactly match the allowlist", async () => {
    const { manager } = await createManagerHarness({
      inboundPolicy: "allowlist",
      allowFrom: ["+15550001234"],
    });

    manager.processEvent({
      id: "evt-allowlist-exact",
      type: "call.initiated",
      callId: "call-exact",
      providerCallId: "provider-exact",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15550001234",
      to: "+15550000000",
    });

    expect(manager.getCallByProviderCallId("provider-exact")).toBeDefined();
  });
});
