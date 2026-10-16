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

const verifiedFaceTimeTransport = {
  kind: "facetime",
  classifier_version: "tu-provider-v1",
  service: 2,
  facetime_transport_type: 1,
  provider_classified: true,
  provider_is_facetime: true,
  provider_is_telephony: false,
  is_using_baseband: false,
  is_wifi_call: false,
  is_voip: true,
  is_emergency: false,
};

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
    const event = call({
      proxy_identifier: "proxy-1",
      conversation_uuid: "conversation-1",
      conversation_group_uuid: "group-1",
      conversation_audio_enabled: true,
      conversation_video_enabled: false,
      conversation_av_mode: 1,
      conversation_resolved_audio_video_mode: "1",
      is_sending_audio: true,
      is_sending_transmission: true,
      is_sending_video: false,
      is_uplink_muted: false,
      local_meter_level: "0.37",
      remote_meter_level: 0.18,
      handle: { value: "mailto:omar@example.com" },
      transport: verifiedFaceTimeTransport,
    });
    expect(event.data).toMatchObject({
      call_uuid: "call-1",
      proxy_identifier: "proxy-1",
      conversation_uuid: "conversation-1",
      conversation_group_uuid: "group-1",
      conversation_audio_enabled: true,
      conversation_video_enabled: false,
      conversation_av_mode: 1,
      conversation_resolved_audio_video_mode: 1,
      call_status: 4,
      is_sending_audio: true,
      is_sending_transmission: true,
      is_sending_video: false,
      is_uplink_muted: false,
      local_meter_level: 0.37,
      remote_meter_level: 0.18,
    });
    expect(isIncomingRingingCall(event)).toBe(true);
    expect(isActiveCall(event)).toBe(false);
    expect(isEndedCall(event)).toBe(false);
  });

  it("does not grant owner authority outside the FaceTime allowlist", () => {
    expect(
      owner(
        call({
          handle: { value: "stranger@example.com" },
          transport: verifiedFaceTimeTransport,
        }),
      ),
    ).toBeUndefined();
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

  it("requires explicit native ended evidence and fails unknown numeric states closed", () => {
    const ended = call({ call_status: 6, has_ended: true });
    const unknown = call({ call_status: 99 });
    expect(isEndedCall(ended)).toBe(true);
    expect(isEndedCall(unknown)).toBe(false);
    expect(isUnknownCallStatus(unknown)).toBe(true);
  });

  it.each([
    {
      name: "cellular",
      patch: {
        kind: "cellular",
        service: 1,
        facetime_transport_type: 0,
        provider_is_facetime: false,
        provider_is_telephony: true,
        is_wifi_call: true,
      },
    },
    {
      name: "telephony provider",
      patch: {
        service: 1,
        provider_is_facetime: false,
        provider_is_telephony: true,
      },
    },
    { name: "baseband", patch: { is_using_baseband: true } },
    { name: "Wi-Fi calling", patch: { is_wifi_call: true } },
    { name: "unknown provider", patch: { provider_classified: false } },
  ])("rejects a matching owner handle on $name transport", ({ patch }) => {
    expect(
      owner(
        call({
          handle: { value: "+12065550123" },
          transport: { ...verifiedFaceTimeTransport, ...patch },
        }),
        "+12065550123",
      ),
    ).toBeUndefined();
  });

  it.each([0, 3])("keeps an outbound status-%i call pending", (call_status) => {
    const event = call({ call_status, is_outgoing: true });
    expect(event).toBeDefined();
    expect(isOutgoingRingingCall(event)).toBe(true);
    expect(isEndedCall(event)).toBe(false);
  });
});
