import { describe, expect, it } from "vitest";
import { validateLastBusyMessageOutcome } from "./index.js";

describe("LastBusyMessageOutcome schema", () => {
  it("accepts steer accepted outcomes", () => {
    expect(
      validateLastBusyMessageOutcome({
        kind: "active_run_steer_accepted",
        label: "Steered into active run",
        recordedAtMs: 1_700_000_000_000,
        source: "inbound",
      }),
    ).toBe(true);
  });

  it("accepts steer fallback outcomes with structured reason", () => {
    expect(
      validateLastBusyMessageOutcome({
        kind: "active_run_steer_rejected",
        label: "Active run rejected steering (not_streaming)",
        reason: "not_streaming",
        recordedAtMs: 1_700_000_000_000,
        source: "slash_steer",
      }),
    ).toBe(true);
  });

  it("accepts follow-up queue outcomes", () => {
    expect(
      validateLastBusyMessageOutcome({
        kind: "followup_enqueued",
        label: "Queued as follow-up",
        recordedAtMs: 1_700_000_000_000,
      }),
    ).toBe(true);
  });

  it("rejects unknown outcome kinds", () => {
    expect(
      validateLastBusyMessageOutcome({
        kind: "unknown",
        label: "bad",
        recordedAtMs: 1,
      }),
    ).toBe(false);
  });
});
