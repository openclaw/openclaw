import { describe, expect, it } from "vitest";
import {
  isActiveCall,
  isEndedCall,
  isIncomingRingingCall,
  isOutgoingRingingCall,
  isUnknownCallStatus,
  normalizeFaceTimeCallEvent,
  normalizeFaceTimeHandle,
  resolveAuthorizedFaceTimeOwner,
} from "../src/call-events.js";
import { incomingCall } from "./fixtures.test-support.js";

const verifiedFaceTimeTransport = incomingCall().data.transport;
const telephony = { service: 1, provider_is_facetime: false, provider_is_telephony: true };

function call(data: Record<string, unknown>) {
  return normalizeFaceTimeCallEvent({
    event: "ft-call-status-changed",
    data: { call_uuid: "call-1", call_status: 4, is_outgoing: false, ...data },
  })!;
}

const owner = (event: ReturnType<typeof call>, handle = "owner@example.com") =>
  resolveAuthorizedFaceTimeOwner({ event, ownerHandles: [handle] });

describe("FaceTime call events", () => {
  it("normalizes helper call-status events", () => {
    const normalized = {
      proxy_identifier: "proxy-1",
      conversation_uuid: "conversation-1",
      conversation_group_uuid: "group-1",
      conversation_audio_enabled: true,
      conversation_video_enabled: false,
      conversation_av_mode: 1,
      conversation_resolved_audio_video_mode: 1,
      is_sending_audio: true,
      is_sending_transmission: true,
      is_sending_video: false,
      is_uplink_muted: false,
      local_meter_level: 0.37,
      remote_meter_level: 0.18,
    };
    const event = call({
      ...normalized,
      conversation_resolved_audio_video_mode: "1",
      local_meter_level: "0.37",
    });
    expect(event.data).toMatchObject({
      ...normalized,
      call_uuid: "call-1",
      call_status: 4,
    });
    expect(isIncomingRingingCall(event)).toBe(true);
    expect(isActiveCall(event)).toBe(false);
    expect(isEndedCall(event)).toBe(false);
  });

  it("does not grant owner authority outside the FaceTime allowlist", () => {
    const event = call({ handle: "stranger@example.com", transport: verifiedFaceTimeTransport });
    expect(owner(event)).toBeUndefined();
  });

  it("uses the exact authorized candidate from nested handle dictionaries", () => {
    const event = call({
      handle: {
        isoCountryCode: "us",
        value: "display@example.com",
        person: { handle: { normalizedValue: "MAILTO:Owner@Example.com" } },
      },
      transport: verifiedFaceTimeTransport,
    });
    expect(normalizeFaceTimeHandle(event.data.handle)).toBe("display@example.com");
    expect(owner(event)).toEqual({ senderId: "owner@example.com", senderIsOwner: true });
  });

  it("recognizes disconnected without an ended timestamp and fails unknown states closed", () => {
    const ended = call({ call_status: 6, has_ended: false });
    const unknown = call({ call_status: 99 });
    expect(isEndedCall(ended)).toBe(true);
    expect(isUnknownCallStatus(ended)).toBe(false);
    expect(isEndedCall(unknown)).toBe(false);
    expect(isUnknownCallStatus(unknown)).toBe(true);
  });

  it.each([
    [
      "cellular",
      {
        ...telephony,
        kind: "cellular",
        facetime_transport_type: 0,
        is_wifi_call: true,
      },
    ],
    ["telephony provider", telephony],
    ["baseband", { is_using_baseband: true }],
    ["Wi-Fi calling", { is_wifi_call: true }],
    ["unknown provider", { provider_classified: false }],
  ] as const)("rejects a matching owner handle on %s transport", (_name, patch) => {
    const event = call({
      handle: { value: "+12065550123" },
      transport: { ...verifiedFaceTimeTransport, ...patch },
    });
    expect(owner(event, "+12065550123")).toBeUndefined();
  });

  it.each([0, 3])("keeps an outbound status-%i call pending", (call_status) => {
    const event = call({ call_status, is_outgoing: true });
    expect(event).toBeDefined();
    expect(isOutgoingRingingCall(event)).toBe(true);
    expect(isEndedCall(event)).toBe(false);
  });
});
