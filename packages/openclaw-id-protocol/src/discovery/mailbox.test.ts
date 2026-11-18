import { describe, expect, it } from "vitest";
import { MEMBER_BROWSER_REQUEST_TTL_SECONDS } from "../index.js";
import {
  isMemberBrowserRequestPayload,
  isValidNotice,
  MAILBOX_NOTICE_EVENTS,
  noticeRecipientAllowed,
  parseSeqConflictRef,
} from "./mailbox.js";

const FP = `fp:${"ab".repeat(32)}` as const;

it("exports the bounded, key-free member browser hint through the canonical index", () => {
  expect(MEMBER_BROWSER_REQUEST_TTL_SECONDS).toBe(1800);
  const payload = {
    kind: "member_browser_request",
    request_id: "ab".repeat(16),
    action: "request",
    member_account_id: "member",
    label: "Browser",
    expires_at: 1800,
  };
  expect(isMemberBrowserRequestPayload(payload)).toBe(true);
  expect(isMemberBrowserRequestPayload({ ...payload, action: "cancel" })).toBe(true);
  for (const bad of [
    { request_id: "abc" },
    { action: "approve" },
    { expires_at: 1.5 },
    { member_account_id: "" },
    { member_account_id: "x".repeat(257) },
    { label: " " },
    { label: "x".repeat(257) },
    { peer_key: "iroh:key" },
    { device_pub: "ed25519:key" },
  ]) {
    expect(isMemberBrowserRequestPayload({ ...payload, ...bad })).toBe(false);
  }
});

describe("mailbox notices", () => {
  it("sends member device notices to owners, never to self", () => {
    expect(isValidNotice("member_device_added", `fp:${"ab".repeat(32)}`)).toBe(true);
    expect(noticeRecipientAllowed("member_device_added", "owners")).toBe(true);
    for (const event of MAILBOX_NOTICE_EVENTS) {
      expect(noticeRecipientAllowed(event, "self")).toBe(false);
    }
  });
  it("lists seq_conflict among the notice events", () => {
    expect(MAILBOX_NOTICE_EVENTS).toContain("seq_conflict");
  });

  it("sends seq_conflict only to one device, never to all owners or the Gateway", () => {
    expect(noticeRecipientAllowed("seq_conflict", FP)).toBe(true);
    expect(noticeRecipientAllowed("seq_conflict", "owners")).toBe(false);
    expect(noticeRecipientAllowed("seq_conflict", "gateway")).toBe(false);
    expect(noticeRecipientAllowed("kit_used", "owners")).toBe(true);
    expect(noticeRecipientAllowed("kit_used", FP)).toBe(true);
    expect(noticeRecipientAllowed("kit_used", "gateway")).toBe(false);
  });

  it("sends rebind only to all owner devices, with the new binding_seq as ref", () => {
    expect(noticeRecipientAllowed("rebind", "owners")).toBe(true);
    expect(noticeRecipientAllowed("rebind", FP)).toBe(false);
    expect(noticeRecipientAllowed("rebind", "gateway")).toBe(false);
    expect(isValidNotice("rebind", "2")).toBe(true);
    expect(isValidNotice("rebind", "two")).toBe(false);
  });

  it.each([
    ["0", 0],
    ["7", 7],
    ["123456789012345", 123456789012345],
    ["07", undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["", undefined],
    ["1234567890123456", undefined],
    [" 3", undefined],
  ])("parses seq_conflict ref %j as %j", (ref, seq) => {
    expect(parseSeqConflictRef(ref)).toBe(seq);
  });

  it("validates events and refs", () => {
    expect(isValidNotice("seq_conflict", "12")).toBe(true);
    expect(isValidNotice("seq_conflict", "twelve")).toBe(false);
    expect(isValidNotice("kit_used", FP)).toBe(true);
    expect(isValidNotice("kit_used", "")).toBe(false);
    expect(isValidNotice("kit_used", "x".repeat(129))).toBe(false);
    expect(isValidNotice("rotation_conflict", 3)).toBe(false);
    expect(isValidNotice("made_up", "1")).toBe(false);
  });
});
