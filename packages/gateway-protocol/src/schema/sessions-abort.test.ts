import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionsAbortResultSchema } from "./sessions.js";

describe("sessions.abort result schema", () => {
  it("accepts legacy broad results and additive exact run state", () => {
    expect(
      Value.Check(SessionsAbortResultSchema, {
        ok: true,
        abortedRunId: null,
        status: "no-active-run",
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionsAbortResultSchema, {
        ok: true,
        abortedRunId: null,
        status: "no-active-run",
        runState: "completed",
        terminalStatus: "timeout",
      }),
    ).toBe(true);
  });

  it("rejects unknown run and terminal states", () => {
    expect(
      Value.Check(SessionsAbortResultSchema, {
        ok: true,
        abortedRunId: null,
        status: "no-active-run",
        runState: "missing",
      }),
    ).toBe(false);
  });
});
