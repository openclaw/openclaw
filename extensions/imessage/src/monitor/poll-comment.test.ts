// Covers the poll-comment folder: a native poll's caption is an inline reply to
// the poll balloon and must be folded (dropped) rather than delivered as a
// standalone message the agent answers in prose.
import { describe, expect, it } from "vitest";
import { createPollCommentFolder } from "./poll-comment.js";

describe("createPollCommentFolder", () => {
  it("folds a reply that targets a remembered poll by numeric rowid", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(6516, "759F39D7-1A30");
    expect(folder.isPollComment(6516)).toBe(true);
  });

  it("folds a reply that targets a remembered poll by guid", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(6516, "759F39D7-1A30");
    // imsg may report the reply target as the guid string instead of the rowid.
    expect(folder.isPollComment("759F39D7-1A30")).toBe(true);
  });

  it("does not fold a reply to an unrelated message", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(6516, "759F39D7-1A30");
    expect(folder.isPollComment(9999)).toBe(false);
    expect(folder.isPollComment("SOME-OTHER-GUID")).toBe(false);
  });

  it("does not fold a non-reply (no reply target)", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(6516, "759F39D7-1A30");
    expect(folder.isPollComment(null)).toBe(false);
    expect(folder.isPollComment(undefined)).toBe(false);
  });

  it("expires remembered polls after the TTL", () => {
    let clock = 1_000;
    const folder = createPollCommentFolder({ ttlMs: 60_000, now: () => clock });
    folder.rememberPoll(6516, "759F39D7-1A30");
    clock += 30_000;
    expect(folder.isPollComment(6516)).toBe(true);
    clock += 40_000; // now 70s since remembered, past the 60s TTL
    expect(folder.isPollComment(6516)).toBe(false);
  });

  it("does not fold before the poll has been seen (ordering safety)", () => {
    const folder = createPollCommentFolder();
    // Caption processed before the poll was remembered — falls back to delivery.
    expect(folder.isPollComment(6516)).toBe(false);
    folder.rememberPoll(6516, "759F39D7-1A30");
    expect(folder.isPollComment(6516)).toBe(true);
  });
});
