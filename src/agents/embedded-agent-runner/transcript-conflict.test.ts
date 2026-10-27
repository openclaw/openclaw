import { expect, it } from "vitest";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { createEmbeddedRunReplayState } from "./replay-state.js";
import {
  isReplaySafeTranscriptConflict,
  isTranscriptConflictReplaySafe,
  isTranscriptRewriteConflict,
  ReplaySafeTranscriptConflictError,
} from "./transcript-conflict.js";

const safe = { replayMetadata: { replaySafe: true, hadPotentialSideEffects: false } };
it("requires positive whole-run replay evidence and refuses already started effects", () => {
  const previous = createEmbeddedRunReplayState();
  expect(isTranscriptConflictReplaySafe(previous, safe)).toBe(true);
  for (const attempt of [
    {},
    { replayMetadata: { replaySafe: false, hadPotentialSideEffects: false } },
    { replayMetadata: { replaySafe: true, hadPotentialSideEffects: true } },
    { ...safe, didSendDeterministicApprovalPrompt: true },
    {
      ...safe,
      clientToolCalls: [{ name: "external-effect", params: {} }],
    },
    { ...safe, didSendViaMessagingTool: true },
    { ...safe, messagingToolSentTexts: ["Already sent"] },
    {
      ...safe,
      acceptedSessionSpawns: [
        { runId: "started-child", childSessionKey: "agent:main:subagent:started-child" },
      ],
    },
  ]) {
    expect(isTranscriptConflictReplaySafe(previous, attempt)).toBe(false);
  }
  expect(
    isTranscriptConflictReplaySafe(createEmbeddedRunReplayState({ replayInvalid: true }), safe),
  ).toBe(false);
  expect(
    isTranscriptConflictReplaySafe(
      createEmbeddedRunReplayState({ hadPotentialSideEffects: true }),
      safe,
    ),
  ).toBe(false);
});
it("recognizes only the live typed safety proof, including wrapped failures", () => {
  const conflict = new SqliteTranscriptMutationConflictError("fixture");
  const safeConflict = new ReplaySafeTranscriptConflictError(conflict);
  expect(
    isReplaySafeTranscriptConflict(new Error("dispatch failed", { cause: safeConflict })),
  ).toBe(true);
  expect(isReplaySafeTranscriptConflict(conflict)).toBe(false);
  expect(isReplaySafeTranscriptConflict(new Error(conflict.message))).toBe(false);
  expect(isReplaySafeTranscriptConflict({ name: "ReplaySafeTranscriptConflictError" })).toBe(false);
});

it("recognizes rewrite revision conflicts from either owner, including wrapped failures", () => {
  for (const error of [
    new SqliteTranscriptMutationConflictError("fixture"),
    new Error("Session transcript changed before rewrite preparation"),
    new Error("Session transcript changed before rewrite publication"),
    new Error("dispatch failed", {
      cause: new Error("Session transcript changed before rewrite publication"),
    }),
  ]) {
    expect(isTranscriptRewriteConflict(error)).toBe(true);
  }
  // Read fences and projection rebuilds are different failures and stay fatal.
  for (const error of [
    new Error("Session transcript changed during context read"),
    new Error("Session transcript projection is rebuilding: fixture"),
    new Error("other failure"),
    { name: "SqliteTranscriptMutationConflictError" },
  ]) {
    expect(isTranscriptRewriteConflict(error)).toBe(false);
  }
});
