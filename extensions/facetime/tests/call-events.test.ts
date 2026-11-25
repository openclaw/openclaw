import { expect, it } from "vitest";
import {
  isEndedCall,
  isOutgoingRingingCall,
  isUnknownCallStatus,
  normalizeFaceTimeCallEvent,
  normalizeFaceTimeHandle,
  resolveAuthorizedFaceTimeOwner,
} from "../src/call-events.js";
import type { FaceTimeCallStatusEvent } from "../src/call-events.js";
import {
  doesFaceTimeCallMatchPendingDial,
  normalizeFaceTimeOutboundIdentityEvent,
  resolveFaceTimeDialRequest,
  resolveFaceTimeDialResult,
  retainFaceTimeDialCallUUID,
  type PendingFaceTimeDial,
} from "../src/outbound-call.js";
import { incomingCall, pendingDial } from "./fixtures.test-support.js";

const telephony = { service: 1, provider_is_facetime: false, provider_is_telephony: true };

function call(data: Record<string, unknown>) {
  return normalizeFaceTimeCallEvent(incomingCall(4, data))!;
}

const owner = (event: ReturnType<typeof call>, handle = "owner@example.com") =>
  resolveAuthorizedFaceTimeOwner({ event, ownerHandles: [handle] });

it("normalizes helper telemetry and authorizes the exact nested handle candidate", () => {
  const event = call({
    conversation_resolved_audio_video_mode: "1",
    local_meter_level: "0.37",
    handle: {
      isoCountryCode: "us",
      value: "display@example.com",
      person: { handle: { normalizedValue: "MAILTO:Owner@Example.com" } },
    },
  });
  expect(event.data).toMatchObject({
    conversation_resolved_audio_video_mode: 1,
    local_meter_level: 0.37,
  });
  expect(normalizeFaceTimeHandle(event.data.handle)).toBe("display@example.com");
  expect(owner(event)).toEqual({ senderId: "owner@example.com", senderIsOwner: true });
});

it("fails unknown states closed", () => {
  const unknown = call({ call_status: 99 });
  expect(isEndedCall(unknown)).toBe(false);
  expect(isUnknownCallStatus(unknown)).toBe(true);
});

it.each([
  ["cellular", { kind: "cellular" }],
  ["telephony provider", telephony],
  ["baseband", { is_using_baseband: true }],
  ["Wi-Fi calling", { is_wifi_call: true }],
  ["unknown provider", { provider_classified: false }],
] as const)("rejects a matching owner handle on %s transport", (_name, patch) => {
  const event = call({
    handle: { value: "+12065550123" },
    transport: { ...incomingCall().data.transport, ...patch },
  });
  expect(owner(event, "+12065550123")).toBeUndefined();
});

it.each([0, 3])("keeps an outbound status-%i call pending", (call_status) => {
  const event = call({ call_status, is_outgoing: true });
  expect(isOutgoingRingingCall(event)).toBe(true);
  expect(isEndedCall(event)).toBe(false);
});

const ownerHandles = ["Owner@example.com", "+1 (206) 555-0100"];
it.each([
  { handle: "owner@example.com", mode: undefined, expected: "audio" },
  { handle: "+12065550100", mode: "video", expected: "video" },
])("authorizes $handle with mode $expected", ({ handle, mode, expected }) => {
  expect(resolveFaceTimeDialRequest({ handle, mode, ownerHandles })).toEqual({
    handle,
    mode: expected,
  });
});

it.each([
  ["stranger@example.com", undefined, "not an authorized owner handle"],
  ["facetime:owner@example.com", undefined, "must not include a URL scheme"],
  ["owner@example.com?ignored=true", undefined, "unsupported characters"],
  ["owner@example.com\nsecond@example.com", undefined, "unsupported characters"],
  ["owner@example.com", "screen-share", "mode must be audio or video"],
])("rejects handle %j with mode %j", (handle, mode, error) => {
  expect(() => resolveFaceTimeDialRequest({ handle, mode, ownerHandles })).toThrow(error);
});
const request = { handle: "owner@example.com", mode: "video" as const };
it.each([
  [null, " proxy-1 ", { state: "pending", proxyIdentifier: "proxy-1" }],
  [" call-3 ", undefined, { state: "ringing", callUUID: "call-3" }],
] as const)("reports native identity %s", (call_uuid, proxy_identifier, expected) => {
  expect(
    resolveFaceTimeDialResult({
      dialID: "dial-1",
      request,
      helper: {
        muted: true,
        is_uplink_muted: true,
        transport: incomingCall().data.transport,
        call_uuid,
        proxy_identifier,
      },
    }),
  ).toMatchObject({ ...request, dialID: "dial-1", ...expected });
});
const identify = (data: Record<string, unknown>) =>
  normalizeFaceTimeOutboundIdentityEvent({ event: "ft-outbound-call-identified", data });
it("retains Apple's exact proxy identity before delayed dial acceptance", () => {
  expect(identify({ dial_id: " dial-1 ", call_uuid: null, proxy_identifier: " proxy-1 " })).toEqual(
    {
      event: "ft-outbound-call-identified",
      data: { dial_id: "dial-1", proxy_identifier: "proxy-1" },
    },
  );
});

it("rejects identity events without an exact carrier identity", () => {
  expect(identify({ dial_id: "dial-1" })).toBeUndefined();
});
const pending = pendingDial({ dialID: "dial-1" });
const matches = (data: Partial<FaceTimeCallStatusEvent["data"]>, dial: PendingFaceTimeDial) =>
  doesFaceTimeCallMatchPendingDial({
    event: call({ call_uuid: "call-3", call_status: 3, is_outgoing: true, ...data }),
    pending: dial,
  });

it.each([
  ["stale same-handle UUID", { handle: pending.handle }, { callUUID: "call-new" }, false],
  [
    "dial ID beats provisional identity",
    { dial_id: "dial-1", call_uuid: "carrier-call" },
    { callUUID: "provisional-call" },
    true,
  ],
  ["wrong dial ID beats matching UUID", { dial_id: "other-dial" }, { callUUID: "call-3" }, false],
  ["proxy-only identity", { proxy_identifier: "proxy-1" }, { proxyIdentifier: "proxy-1" }, true],
  ["same handle without identity", { handle: pending.handle }, { delivery: "ambiguous" }, false],
] satisfies Array<
  [string, Partial<FaceTimeCallStatusEvent["data"]>, Partial<PendingFaceTimeDial>, boolean]
>)("%s", (_name, data, overrides, expected) => {
  expect(matches(data, { ...pending, ...overrides })).toBe(expected);
});

it("matches current and retained UUIDs when an event omits the dial ID", () => {
  const aliased = { ...pending };
  retainFaceTimeDialCallUUID(aliased, "call-3");
  expect(matches({}, aliased)).toBe(true);
  retainFaceTimeDialCallUUID(aliased, "carrier-call");
  expect(aliased.callUUID).toBe("carrier-call");
  expect(matches({}, aliased)).toBe(true);
});
