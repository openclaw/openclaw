// Covers the poll-comment folder: a native poll's caption is an inline reply to
// the poll balloon that lands WITH the poll, and must be folded (dropped) rather
// than delivered as a standalone message the agent answers in prose. A
// deliberate later inline reply to the poll must NOT be folded.
import { describe, expect, it } from "vitest";
import { createPollCommentFolder } from "./poll-comment.js";

const T0 = 1_000_000; // arbitrary base timestamp (ms)

describe("createPollCommentFolder", () => {
  it("folds a caption reply that lands with the poll (numeric rowid)", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(6516, "759F39D7-1A30", T0);
    // Caption ships with the poll — same instant.
    expect(folder.isPollComment(6516, T0)).toBe(true);
  });

  it("folds a caption reply matched by guid", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(6516, "759F39D7-1A30", T0);
    expect(folder.isPollComment("759F39D7-1A30", T0 + 500)).toBe(true);
  });

  it("does NOT fold a deliberate later inline reply to the poll", () => {
    const folder = createPollCommentFolder({ windowMs: 15_000 });
    folder.rememberPoll(6516, "759F39D7-1A30", T0);
    // A real "I can't make it" reply minutes later must be delivered.
    expect(folder.isPollComment(6516, T0 + 60_000)).toBe(false);
  });

  it("folds a same-sender caption but NOT a group member's quick reply", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(6516, "759F39D7-1A30", T0, "+15551110000");
    // The poll creator's own caption, in-window → folded.
    expect(folder.isPollComment(6516, T0 + 500, "+15551110000")).toBe(true);
    // A different group member replying to the poll in-window → delivered.
    expect(folder.isPollComment(6516, T0 + 500, "+15552220000")).toBe(false);
  });

  it("does not fold a reply to an unrelated message", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(6516, "759F39D7-1A30", T0);
    expect(folder.isPollComment(9999, T0)).toBe(false);
    expect(folder.isPollComment("SOME-OTHER-GUID", T0)).toBe(false);
  });

  it("does not fold a non-reply or a reply with no usable timestamp", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(6516, "759F39D7-1A30", T0);
    expect(folder.isPollComment(null, T0)).toBe(false);
    expect(folder.isPollComment(6516, Number.NaN)).toBe(false);
  });

  it("does not track a poll without a usable timestamp", () => {
    const folder = createPollCommentFolder();
    folder.rememberPoll(6516, "759F39D7-1A30", Number.NaN);
    expect(folder.isPollComment(6516, T0)).toBe(false);
  });

  it("does not fold before the poll has been seen (ordering safety)", () => {
    const folder = createPollCommentFolder();
    expect(folder.isPollComment(6516, T0)).toBe(false);
    folder.rememberPoll(6516, "759F39D7-1A30", T0);
    expect(folder.isPollComment(6516, T0)).toBe(true);
  });
});
