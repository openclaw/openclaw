import { describe, expect, it } from "vitest";
import type { FaceTimeCallStatusEvent } from "../src/call-events.js";
import {
  doesFaceTimeCallMatchPendingDial,
  normalizeFaceTimeOutboundIdentityEvent,
  resolveFaceTimeDialRequest,
  resolveFaceTimeDialResult,
  retainFaceTimeDialCallUUID,
  type PendingFaceTimeDial,
} from "../src/outbound-call.js";

describe("resolveFaceTimeDialRequest", () => {
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
});

describe("resolveFaceTimeDialResult", () => {
  const request = { handle: "owner@example.com", mode: "video" as const };
  const safeCarrier = {
    muted: true,
    is_uplink_muted: true,
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
    ).toMatchObject({
      ...request,
      dialID: "dial-1",
      ...expected,
    });
  });
});

describe("normalizeFaceTimeOutboundIdentityEvent", () => {
  it("retains Apple's exact proxy identity before delayed dial acceptance", () => {
    expect(
      normalizeFaceTimeOutboundIdentityEvent({
        event: "ft-outbound-call-identified",
        data: { dial_id: " dial-1 ", call_uuid: null, proxy_identifier: " proxy-1 " },
      }),
    ).toEqual({
      event: "ft-outbound-call-identified",
      data: { dial_id: "dial-1", proxy_identifier: "proxy-1" },
    });
  });

  it("rejects identity events without an exact carrier identity", () => {
    expect(
      normalizeFaceTimeOutboundIdentityEvent({
        event: "ft-outbound-call-identified",
        data: { dial_id: "dial-1" },
      }),
    ).toBeUndefined();
  });
});

describe("doesFaceTimeCallMatchPendingDial", () => {
  const event = {
    event: "ft-call-status-changed" as const,
    data: {
      call_uuid: "call-3",
      call_status: 3,
      is_outgoing: true,
      handle: "reformatted@example.com",
    },
  };
  const pending: PendingFaceTimeDial = {
    version: 1,
    ownerEpoch: 1,
    dialID: "dial-1",
    delivery: "accepted",
    handle: "owner@example.com",
    mode: "video",
    requestedAt: "2026-07-20T17:52:00.000Z",
  };
  const matches = (data: Partial<FaceTimeCallStatusEvent["data"]>, dial: PendingFaceTimeDial) =>
    doesFaceTimeCallMatchPendingDial({
      event: { ...event, data: { ...event.data, ...data } },
      pending: dial,
    });

  it.each([
    {
      name: "rejects a stale same-handle UUID",
      data: { handle: pending.handle },
      pending: { callUUID: "call-new" },
      matches: false,
    },
    {
      name: "prefers exact dial ID over provisional identity",
      data: { dial_id: "dial-1", call_uuid: "carrier-call", proxy_identifier: "carrier-proxy" },
      pending: { callUUID: "provisional-call", proxyIdentifier: "provisional-proxy" },
      matches: true,
    },
    {
      name: "rejects mismatched dial ID despite matching UUID",
      data: { dial_id: "other-dial" },
      pending: { callUUID: "call-3" },
      matches: false,
    },
    {
      name: "matches a proxy before UUID assignment",
      data: { proxy_identifier: "proxy-1" },
      pending: { proxyIdentifier: "proxy-1" },
      matches: true,
    },
    {
      name: "never adopts a same-handle event without exact identity",
      data: { handle: pending.handle },
      pending: { delivery: "ambiguous" as const },
      matches: false,
    },
  ])("$name", ({ data, pending: overrides, matches: expected }) => {
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
});
