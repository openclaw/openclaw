import { describe, expect, it } from "vitest";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/session-transcript-writer-claim-error.js";
import {
  classifySessionTranscriptContinuityError,
  SessionTranscriptContinuityError,
} from "./transcript-turn-error.js";

describe("transcript continuity classification", () => {
  it.each([
    [
      new SessionTranscriptContinuityError("missing_active_anchor", "anchor refused"),
      "missing_active_anchor",
    ],
    [new SessionTranscriptReadFenceError("Admission identity changed"), "projection_read_fence"],
    [new SessionTranscriptWriterClaimReboundError(), "writer_replaced"],
    [
      {
        name: "SessionTranscriptReadFenceError",
        message: "Current-turn transcript admission changed",
      },
      "projection_read_fence",
    ],
    [
      { name: "SessionTranscriptWriterClaimReboundError", message: "Writer refused" },
      "writer_replaced",
    ],
    [
      "Error: Session transcript anchor was not returned: synthetic-anchor",
      "missing_active_anchor",
    ],
    [{ message: "Session transcript changed during context read" }, "projection_read_fence"],
    [{ message: "session writer claim changed before transcript persistence" }, "writer_replaced"],
  ] as const)("recognizes the native or serialized refusal %#", (error, kind) => {
    expect(classifySessionTranscriptContinuityError(error)).toBe(kind);
  });

  it("retains a primary continuity refusal through secondary persistence and cyclic wrappers", () => {
    const primary = new SessionTranscriptContinuityError("missing_active_anchor", "anchor refused");
    const secondary = new Error("Terminal persistence refused");
    const error = Object.assign(new Error("cleanup failed"), {
      name: "SuppressedError",
      error: secondary,
      suppressed: primary,
      cause: undefined as unknown,
    });
    error.cause = error;
    expect(classifySessionTranscriptContinuityError(error)).toBe("missing_active_anchor");
    expect(error.error).toBe(secondary);
    expect(error.suppressed).toBe(primary);
  });

  it.each([
    "Session transcript anchor was not returned:",
    "Session transcript anchor was not returned: synthetic-anchor: retry later",
    "Provider says Session transcript changed during context read",
    "Session transcript changed during context read; try again",
    "session writer claim changed before transcript persistence later",
    "503 overloaded",
  ])("does not reinterpret provider text or near matches: %s", (message) => {
    expect(classifySessionTranscriptContinuityError(new Error(message))).toBeUndefined();
  });
});
