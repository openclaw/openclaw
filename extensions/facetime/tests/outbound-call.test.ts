import { describe, expect, it } from "vitest";
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

  it("defaults an authorized owner email handle to audio", () => {
    expect(resolveFaceTimeDialRequest({ handle: "owner@example.com", ownerHandles })).toEqual({
      handle: "owner@example.com",
      mode: "audio",
    });
  });

  it("accepts an explicit video call and canonical phone match", () => {
    expect(
      resolveFaceTimeDialRequest({
        handle: "+12065550100",
        mode: "video",
        ownerHandles,
      }),
    ).toEqual({ handle: "+12065550100", mode: "video" });
  });

  it("rejects a target outside the allowlist", () => {
    expect(() =>
      resolveFaceTimeDialRequest({ handle: "stranger@example.com", ownerHandles }),
    ).toThrow("not an authorized owner handle");
  });

  it.each([
    "facetime:owner@example.com",
    "owner@example.com?ignored=true",
    "owner@example.com\nsecond@example.com",
  ])("rejects unsafe handle %j", (handle) => {
    expect(() => resolveFaceTimeDialRequest({ handle, ownerHandles })).toThrow();
  });

  it("rejects unknown call modes", () => {
    expect(() =>
      resolveFaceTimeDialRequest({
        handle: "owner@example.com",
        mode: "screen-share",
        ownerHandles,
      }),
    ).toThrow("mode must be audio or video");
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

  it("accepts a native dial that has not received its call UUID yet", () => {
    expect(
      resolveFaceTimeDialResult({
        dialID: "dial-1",
        request,
        helper: {
          ...safeCarrier,
          call_uuid: null,
          proxy_identifier: " proxy-1 ",
          handle: request.handle,
          mode: request.mode,
        },
      }),
    ).toMatchObject({
      handle: request.handle,
      mode: request.mode,
      dialID: "dial-1",
      state: "pending",
      proxyIdentifier: "proxy-1",
    });
  });

  it("reports ringing when the helper returns a call UUID immediately", () => {
    expect(
      resolveFaceTimeDialResult({
        dialID: "dial-2",
        request,
        helper: { ...safeCarrier, call_uuid: " call-3 " },
      }),
    ).toMatchObject({
      state: "ringing",
      callUUID: "call-3",
    });
  });
});

describe("normalizeFaceTimeOutboundIdentityEvent", () => {
  it("retains Apple's exact proxy identity before delayed dial acceptance", () => {
    expect(
      normalizeFaceTimeOutboundIdentityEvent({
        event: "ft-outbound-call-identified",
        data: {
          dial_id: " dial-1 ",
          call_uuid: null,
          proxy_identifier: " proxy-1 ",
        },
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

  it.each([
    {
      name: "uses UUID as the authoritative identity once assigned",
      data: {},
      pending: { callUUID: "call-3" },
      matches: true,
    },
    {
      name: "does not match a stale same-handle event to a different known UUID",
      data: { handle: "owner@example.com" },
      pending: { callUUID: "call-new" },
      matches: false,
    },
    {
      name: "prefers an exact dial ID while Apple's provisional identity changes",
      data: { dial_id: "dial-1", call_uuid: "carrier-call", proxy_identifier: "carrier-proxy" },
      pending: { callUUID: "provisional-call", proxyIdentifier: "provisional-proxy" },
      matches: true,
    },
    {
      name: "rejects a mismatched supplied dial ID even when native identity matches",
      data: { dial_id: "other-dial" },
      pending: { callUUID: "call-3" },
      matches: false,
    },
    {
      name: "uses Apple's proxy identity after helper reinjection and before UUID assignment",
      data: { proxy_identifier: "proxy-1" },
      pending: { proxyIdentifier: "proxy-1" },
      matches: true,
    },
    {
      name: "never adopts a same-handle event without exact dial identity",
      data: { handle: "owner@example.com" },
      pending: { delivery: "ambiguous" as const },
      matches: false,
    },
  ])("$name", ({ data, pending: overrides, matches }) => {
    expect(
      doesFaceTimeCallMatchPendingDial({
        event: { ...event, data: { ...event.data, ...data } },
        pending: { ...pending, ...overrides },
      }),
    ).toBe(matches);
  });

  it("matches an earlier retained UUID when an event omits the dial ID", () => {
    const aliased = { ...pending };
    retainFaceTimeDialCallUUID(aliased, "provisional-call");
    retainFaceTimeDialCallUUID(aliased, "carrier-call");
    expect(aliased.callUUID).toBe("carrier-call");

    expect(
      doesFaceTimeCallMatchPendingDial({
        event: { ...event, data: { ...event.data, call_uuid: "provisional-call" } },
        pending: aliased,
      }),
    ).toBe(true);
  });
});
