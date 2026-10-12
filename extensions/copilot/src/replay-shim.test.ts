// Copilot tests cover replay shim plugin behavior.
import { describe, expect, it } from "vitest";
import {
  isMissingCopilotSessionError,
  computeReplayMetadata,
  copilotToolMetasHavePotentialSideEffects,
} from "./replay-shim.js";

describe("isMissingCopilotSessionError", () => {
  it("treats undefined / null as unrecoverable", () => {
    expect(isMissingCopilotSessionError(undefined)).toBe(false);
    expect(isMissingCopilotSessionError(null)).toBe(false);
  });

  it("treats a non-Error throw value as unrecoverable", () => {
    expect(isMissingCopilotSessionError("string-error")).toBe(false);
    expect(isMissingCopilotSessionError(42)).toBe(false);
  });

  it("classifies statusCode:404 errors as missing/recoverable", () => {
    const error = Object.assign(new Error("Not Found"), { statusCode: 404 });
    expect(isMissingCopilotSessionError(error)).toBe(true);
  });

  it("classifies recognised code strings as missing/recoverable", () => {
    for (const code of ["SESSION_NOT_FOUND", "session_not_found", "NotFound", "ENOENT"]) {
      const error = Object.assign(new Error("session gone"), { code });
      expect(isMissingCopilotSessionError(error)).toBe(true);
    }
  });

  it("classifies recognised message patterns as missing/recoverable", () => {
    const messages = [
      "session not found",
      "Session sess-1 not found",
      "Unknown session id sess-1",
      "session id sess-1 does not exist",
      "no such session",
    ];
    for (const message of messages) {
      expect(isMissingCopilotSessionError(new Error(message))).toBe(true);
    }
  });

  it("does not over-match unrelated errors", () => {
    expect(isMissingCopilotSessionError(new Error("network ECONNRESET"))).toBe(false);
    expect(isMissingCopilotSessionError(new Error("Unauthorized"))).toBe(false);
    expect(isMissingCopilotSessionError(new Error("rate limit exceeded"))).toBe(false);
  });

  it("reads message from plain objects with a message string", () => {
    const error = { message: "session not found" };
    expect(isMissingCopilotSessionError(error)).toBe(true);
  });

  it("prefers structured signals over message heuristics", () => {
    // status:404 wins even when message is unrelated
    const error = Object.assign(new Error("Internal server error"), { status: 404 });
    expect(isMissingCopilotSessionError(error)).toBe(true);
  });
});

describe("computeReplayMetadata", () => {
  it("clean attempt with no prior state → replaySafe true", () => {
    expect(computeReplayMetadata({})).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: true,
    });
  });

  it("timeout flips both flags", () => {
    expect(computeReplayMetadata({ thisAttemptTimedOut: true })).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("prior side effects propagate forward", () => {
    expect(computeReplayMetadata({ priorHadPotentialSideEffects: true })).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("current attempt side effects make replay unsafe", () => {
    expect(computeReplayMetadata({ thisAttemptHadPotentialSideEffects: true })).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("prior replayInvalid invalidates replay even without side effects", () => {
    expect(computeReplayMetadata({ priorReplayInvalid: true })).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: false,
    });
  });

  it("downgradedFromResume invalidates replay even without side effects", () => {
    expect(computeReplayMetadata({ thisAttemptDowngradedFromResume: true })).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: false,
    });
  });

  it("resumeFailureRecovered invalidates replay even without side effects", () => {
    expect(computeReplayMetadata({ thisAttemptResumeFailureRecovered: true })).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: false,
    });
  });

  it("treats explicit false flags as if they were absent", () => {
    expect(
      computeReplayMetadata({
        priorReplayInvalid: false,
        priorHadPotentialSideEffects: false,
        thisAttemptTimedOut: false,
        thisAttemptDowngradedFromResume: false,
        thisAttemptResumeFailureRecovered: false,
      }),
    ).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: true,
    });
  });
});

describe("copilotToolMetasHavePotentialSideEffects", () => {
  it("detects mutating tool names", () => {
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "write" }])).toBe(true);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "message_send" }])).toBe(true);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "browser" }])).toBe(true);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "file_fetch" }])).toBe(true);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "file_write" }])).toBe(true);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "read_and_delete" }])).toBe(true);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "search_and_replace" }])).toBe(
      true,
    );
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "session_status" }])).toBe(true);
  });

  it("treats read-only tool names as replay-safe", () => {
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "read" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "search" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "status" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "file_read" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "memory_get" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "sessions_history" }])).toBe(
      false,
    );
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "sessions_list" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "tool_search" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "web_fetch" }])).toBe(false);
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "web_search" }])).toBe(false);
  });

  it("treats memory_search recall tracking as a potential side effect", () => {
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName: "memory_search" }])).toBe(true);
  });

  it("detects async-started tools even without a mutating name", () => {
    expect(
      copilotToolMetasHavePotentialSideEffects([{ asyncStarted: true, toolName: "read" }]),
    ).toBe(true);
  });
});
