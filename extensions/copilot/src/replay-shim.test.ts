// Copilot tests cover replay shim plugin behavior.
import { describe, expect, it } from "vitest";
import {
  isMissingCopilotSessionError,
  computeReplayMetadata,
  copilotToolMetasHavePotentialSideEffects,
} from "./replay-shim.js";

describe("isMissingCopilotSessionError", () => {
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

  it("reads message from plain objects with a message string", () => {
    const error = { message: "session not found" };
    expect(isMissingCopilotSessionError(error)).toBe(true);
  });
});

describe("computeReplayMetadata", () => {
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
