import type { PendingFaceTimeDial } from "../src/outbound-call.js";

export function incomingCall(status = 4, overrides: Record<string, unknown> = {}) {
  return {
    event: "ft-call-status-changed",
    data: {
      call_uuid: "call-1",
      call_status: status,
      has_ended: status === 6,
      is_outgoing: false,
      is_sending_audio: false,
      handle: { value: "owner@example.com" },
      transport: {
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
      },
      ...overrides,
    },
  };
}

export function pendingDial(overrides: Partial<PendingFaceTimeDial> = {}): PendingFaceTimeDial {
  return {
    dialID: "approved-dial",
    version: 1,
    ownerEpoch: 1,
    handle: "owner@example.com",
    mode: "audio",
    delivery: "accepted",
    requestedAt: "2026-08-17T12:00:00.000Z",
    ...overrides,
  };
}
