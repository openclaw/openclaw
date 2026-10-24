import { expect, it } from "vitest";
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
const safeCarrier = {
  muted: true,
  is_uplink_muted: true,
  transport: incomingCall().data.transport,
};
it.each([
  {
    helper: { call_uuid: null, proxy_identifier: " proxy-1 " },
    expected: { state: "pending", proxyIdentifier: "proxy-1" },
  },
  { helper: { call_uuid: " call-3 " }, expected: { state: "ringing", callUUID: "call-3" } },
])("reports $expected.state from native identity", ({ helper, expected }) => {
  expect(
    resolveFaceTimeDialResult({
      dialID: "dial-1",
      request,
      helper: { ...safeCarrier, ...helper },
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
const event = {
  event: "ft-call-status-changed" as const,
  data: {
    call_uuid: "call-3",
    call_status: 3,
    is_outgoing: true,
    handle: "reformatted@example.com",
  },
};
const pending = pendingDial({
  dialID: "dial-1",
  mode: "video",
  requestedAt: "2026-07-20T17:52:00.000Z",
});
const matches = (data: Partial<FaceTimeCallStatusEvent["data"]>, dial: PendingFaceTimeDial) =>
  doesFaceTimeCallMatchPendingDial({
    event: { ...event, data: { ...event.data, ...data } },
    pending: dial,
  });

it.each([
  ["stale same-handle UUID", { handle: pending.handle }, { callUUID: "call-new" }, false],
  [
    "dial ID beats provisional identity",
    { dial_id: "dial-1", call_uuid: "carrier-call", proxy_identifier: "carrier-proxy" },
    { callUUID: "provisional-call", proxyIdentifier: "provisional-proxy" },
    true,
  ],
  ["wrong dial ID beats matching UUID", { dial_id: "other-dial" }, { callUUID: "call-3" }, false],
  [
    "proxy before UUID assignment",
    { proxy_identifier: "proxy-1" },
    { proxyIdentifier: "proxy-1" },
    true,
  ],
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
