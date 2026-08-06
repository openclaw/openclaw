import { describe, expect, it } from "vitest";
import {
  doesPendingFaceTimeDialHaveCallUUID,
  doesFaceTimeCallMatchPendingDial,
  normalizeFaceTimeOutboundIdentityEvent,
  resolveFaceTimeDialRequest,
  resolveFaceTimeDialResult,
  retainFaceTimeDialCallUUID,
} from "../src/outbound-call.js";

describe("resolveFaceTimeDialRequest", () => {
  const whitelistHandles = ["Owner@example.com", "+1 (206) 555-0100"];

  it("defaults an allowlisted email handle to audio", () => {
    expect(resolveFaceTimeDialRequest({ handle: "owner@example.com", whitelistHandles })).toEqual({
      handle: "owner@example.com",
      mode: "audio",
    });
  });

  it("accepts an explicit video call and canonical phone match", () => {
    expect(
      resolveFaceTimeDialRequest({
        handle: "+12065550100",
        mode: "video",
        whitelistHandles,
      }),
    ).toEqual({ handle: "+12065550100", mode: "video" });
  });

  it("rejects a target outside the allowlist", () => {
    expect(() =>
      resolveFaceTimeDialRequest({ handle: "stranger@example.com", whitelistHandles }),
    ).toThrow("not allowlisted");
  });

  it.each([
    "facetime:owner@example.com",
    "owner@example.com?ignored=true",
    "owner@example.com/path",
    "owner@example.com\nsecond@example.com",
  ])("rejects unsafe handle %j", (handle) => {
    expect(() => resolveFaceTimeDialRequest({ handle, whitelistHandles })).toThrow();
  });

  it("rejects unknown call modes", () => {
    expect(() =>
      resolveFaceTimeDialRequest({
        handle: "owner@example.com",
        mode: "screen-share",
        whitelistHandles,
      }),
    ).toThrow("mode must be audio or video");
  });
});

describe("outbound call UUID aliases", () => {
  it("keeps every UUID returned while Apple replaces the carrier object", () => {
    const pending = {
      dialID: "dial-alias",
      delivery: "accepted" as const,
      handle: "owner@example.com",
      mode: "audio" as const,
      requestedAt: "2026-07-20T17:52:00.000Z",
    };

    retainFaceTimeDialCallUUID(pending, "provisional-call");
    retainFaceTimeDialCallUUID(pending, "carrier-call");

    expect(pending.callUUID).toBe("carrier-call");
    expect(doesPendingFaceTimeDialHaveCallUUID(pending, "provisional-call")).toBe(true);
    expect(doesPendingFaceTimeDialHaveCallUUID(pending, "carrier-call")).toBe(true);
    expect(doesPendingFaceTimeDialHaveCallUUID(pending, "unrelated-call")).toBe(false);
  });
});

describe("resolveFaceTimeDialResult", () => {
  const request = { handle: "owner@example.com", mode: "video" as const };

  it("accepts a native dial that has not received its call UUID yet", () => {
    expect(
      resolveFaceTimeDialResult({
        dialID: "dial-1",
        request,
        helper: {
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
        helper: { call_uuid: " call-3 " },
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

  it("uses UUID as the authoritative identity once assigned", () => {
    expect(
      doesFaceTimeCallMatchPendingDial({
        event,
        pending: {
          dialID: "dial-1",
          delivery: "accepted",
          handle: "owner@example.com",
          mode: "video",
          requestedAt: "2026-07-20T17:52:00.000Z",
          callUUID: "call-3",
        },
      }),
    ).toBe(true);
  });

  it("does not match a stale same-handle event to a different known UUID", () => {
    expect(
      doesFaceTimeCallMatchPendingDial({
        event: { ...event, data: { ...event.data, handle: "owner@example.com" } },
        pending: {
          dialID: "dial-2",
          delivery: "accepted",
          handle: "owner@example.com",
          mode: "video",
          requestedAt: "2026-07-20T17:52:00.000Z",
          callUUID: "call-new",
        },
      }),
    ).toBe(false);
  });

  it("uses the native dial ID before the pending request has a UUID", () => {
    expect(
      doesFaceTimeCallMatchPendingDial({
        event: { ...event, data: { ...event.data, dial_id: "dial-3" } },
        pending: {
          dialID: "dial-3",
          delivery: "accepted",
          handle: "owner@example.com",
          mode: "video",
          requestedAt: "2026-07-20T17:52:00.000Z",
        },
      }),
    ).toBe(true);
  });

  it("prefers an exact dial ID while Apple's provisional identity changes", () => {
    expect(
      doesFaceTimeCallMatchPendingDial({
        event: {
          ...event,
          data: {
            ...event.data,
            dial_id: "dial-6",
            call_uuid: "carrier-call",
            proxy_identifier: "carrier-proxy",
          },
        },
        pending: {
          dialID: "dial-6",
          delivery: "accepted",
          handle: "owner@example.com",
          mode: "video",
          requestedAt: "2026-07-20T17:52:00.000Z",
          callUUID: "provisional-call",
          proxyIdentifier: "provisional-proxy",
        },
      }),
    ).toBe(true);
  });

  it("rejects a mismatched supplied dial ID even when native identity matches", () => {
    expect(
      doesFaceTimeCallMatchPendingDial({
        event: { ...event, data: { ...event.data, dial_id: "other-dial" } },
        pending: {
          dialID: "dial-7",
          delivery: "accepted",
          handle: "owner@example.com",
          mode: "video",
          requestedAt: "2026-07-20T17:52:00.000Z",
          callUUID: "call-3",
        },
      }),
    ).toBe(false);
  });

  it("uses Apple's proxy identity after helper reinjection and before UUID assignment", () => {
    expect(
      doesFaceTimeCallMatchPendingDial({
        event: { ...event, data: { ...event.data, proxy_identifier: "proxy-1" } },
        pending: {
          dialID: "dial-5",
          delivery: "accepted",
          handle: "owner@example.com",
          mode: "video",
          requestedAt: "2026-07-20T17:52:00.000Z",
          proxyIdentifier: "proxy-1",
        },
      }),
    ).toBe(true);
  });

  it("matches an earlier retained UUID when an event omits the dial ID", () => {
    const pending = {
      dialID: "dial-alias-event",
      delivery: "accepted" as const,
      handle: "owner@example.com",
      mode: "video" as const,
      requestedAt: "2026-07-20T17:52:00.000Z",
    };
    retainFaceTimeDialCallUUID(pending, "provisional-call");
    retainFaceTimeDialCallUUID(pending, "carrier-call");

    expect(
      doesFaceTimeCallMatchPendingDial({
        event: { ...event, data: { ...event.data, call_uuid: "provisional-call" } },
        pending,
      }),
    ).toBe(true);
  });

  it("never adopts a same-handle event without exact dial identity", () => {
    expect(
      doesFaceTimeCallMatchPendingDial({
        event: { ...event, data: { ...event.data, handle: "owner@example.com" } },
        pending: {
          dialID: "dial-4",
          delivery: "ambiguous",
          handle: "owner@example.com",
          mode: "video",
          requestedAt: "2026-07-20T17:52:00.000Z",
        },
      }),
    ).toBe(false);
  });
});
