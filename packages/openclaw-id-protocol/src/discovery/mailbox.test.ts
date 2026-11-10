import { describe, expect, it } from "vitest";
import {
  isValidNotice,
  MAILBOX_NOTICE_EVENTS,
  noticeRecipientAllowed,
  parseSeqConflictRef,
} from "./mailbox.js";

const FP = `fp:${"ab".repeat(32)}` as const;

describe("mailbox notices", () => {
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
