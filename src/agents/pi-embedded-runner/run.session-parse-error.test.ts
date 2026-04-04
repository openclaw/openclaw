import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { SessionParseError } from "./session-parse-error.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent session parse error handling", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("returns a friendly error payload for SessionParseError (bad control character)", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: new SessionParseError(
          "Bad control character in string literal in JSON at position 544",
          { sessionFile: "/path/to/session.jsonl" },
        ),
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-session-parse-error-control-char",
    });

    expect(result.payloads).toBeDefined();
    expect(result.payloads).toHaveLength(1);
    expect(result.payloads![0]?.isError).toBe(true);
    expect(result.payloads![0]?.text).toContain("Session transcript could not be read");
    expect(result.payloads![0]?.text).toContain("/new");
    expect(result.meta.error?.kind).toBe("session_parse_error");
  });

  it("returns a friendly error payload for SessionParseError (unexpected token)", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: new SessionParseError("Unexpected token < in JSON at position 0", {
          sessionFile: "/path/to/session.jsonl",
        }),
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-session-parse-error-unexpected-token",
    });

    expect(result.payloads).toBeDefined();
    expect(result.payloads).toHaveLength(1);
    expect(result.payloads![0]?.isError).toBe(true);
    expect(result.payloads![0]?.text).toContain("Session transcript could not be read");
    expect(result.meta.error?.kind).toBe("session_parse_error");
  });

  it("does not intercept raw SyntaxErrors not originating from session load (re-throws)", async () => {
    // A SyntaxError thrown inside a tool handler or model decoder is NOT wrapped as
    // SessionParseError — it should propagate rather than show the session-corrupt message.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: new SyntaxError("Unexpected identifier 'foo'"),
      }),
    );

    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        runId: "run-session-parse-error-raw-syntax-rethrows",
      }),
    ).rejects.toThrow("Unexpected identifier 'foo'");
  });

  it("does not intercept non-syntax errors (propagates unknown errors)", async () => {
    const unknownError = new Error("Something unrelated went wrong");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: unknownError,
      }),
    );

    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        runId: "run-session-parse-error-non-syntax",
      }),
    ).rejects.toThrow("Something unrelated went wrong");
  });
});
