// Copilot tests cover replay shim plugin behavior.
import { describe, expect, it } from "vitest";
import {
  isMissingCopilotSessionError,
  computeReplayMetadata,
  copilotToolMetasHavePotentialSideEffects,
} from "./replay-shim.js";

describe("isMissingCopilotSessionError", () => {
  it.each([
    ...[undefined, null, "string-error", 42].map((error) => [error, false] as const),
    [Object.assign(new Error("Not Found"), { statusCode: 404 }), true],
    [Object.assign(new Error("Internal server error"), { status: 404 }), true],
    ...["SESSION_NOT_FOUND", "session_not_found", "NotFound", "ENOENT"].map(
      (code) => [Object.assign(new Error("session gone"), { code }), true] as const,
    ),
    ...[
      "session not found",
      "Session sess-1 not found",
      "Unknown session id sess-1",
      "session id sess-1 does not exist",
      "no such session",
    ].map((message) => [new Error(message), true] as const),
    ...["network ECONNRESET", "Unauthorized", "rate limit exceeded"].map(
      (message) => [new Error(message), false] as const,
    ),
    [{ message: "session not found" }, true],
  ])("classifies %s as recoverable=%s", (error, expected) => {
    expect(isMissingCopilotSessionError(error)).toBe(expected);
  });
});

describe("computeReplayMetadata", () => {
  it.each<
    [
      name: string,
      input: Parameters<typeof computeReplayMetadata>[0],
      hadPotentialSideEffects: boolean,
      replaySafe: boolean,
    ]
  >([
    ["clean attempt", {}, false, true],
    ["timeout", { thisAttemptTimedOut: true }, true, false],
    ["prior effects", { priorHadPotentialSideEffects: true }, true, false],
    ["current effects", { thisAttemptHadPotentialSideEffects: true }, true, false],
    ["prior invalid replay", { priorReplayInvalid: true }, false, false],
    ["downgraded resume", { thisAttemptDowngradedFromResume: true }, false, false],
    ["recovered resume", { thisAttemptResumeFailureRecovered: true }, false, false],
    [
      "explicit false flags",
      {
        priorReplayInvalid: false,
        priorHadPotentialSideEffects: false,
        thisAttemptTimedOut: false,
        thisAttemptDowngradedFromResume: false,
        thisAttemptResumeFailureRecovered: false,
      },
      false,
      true,
    ],
  ])("preserves replay safety for %s", (_name, input, hadPotentialSideEffects, replaySafe) => {
    expect(computeReplayMetadata(input)).toEqual({ hadPotentialSideEffects, replaySafe });
  });
});

describe("copilotToolMetasHavePotentialSideEffects", () => {
  it.each([
    ...[
      "write",
      "message_send",
      "browser",
      "file_fetch",
      "file_write",
      "read_and_delete",
      "search_and_replace",
      "session_status",
      "memory_search",
    ].map((toolName) => [toolName, true] as const),
    ...[
      "read",
      "search",
      "status",
      "file_read",
      "memory_get",
      "sessions_history",
      "sessions_list",
      "tool_search",
      "web_fetch",
      "web_search",
    ].map((toolName) => [toolName, false] as const),
  ])("classifies %s side effects as %s", (toolName, expected) => {
    expect(copilotToolMetasHavePotentialSideEffects([{ toolName }])).toBe(expected);
  });

  it("detects async-started tools even without a mutating name", () => {
    expect(
      copilotToolMetasHavePotentialSideEffects([{ asyncStarted: true, toolName: "read" }]),
    ).toBe(true);
  });
});
