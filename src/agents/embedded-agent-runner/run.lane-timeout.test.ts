import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../timeout.js";
import { __testing } from "./run.js";

describe("resolveEmbeddedRunLaneTimeoutMs", () => {
  it("adds queue grace to explicit run timeouts", () => {
    expect(__testing.resolveEmbeddedRunLaneTimeoutMs(60_000)).toBe(
      60_000 + __testing.EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
    );
    expect(__testing.resolveEmbeddedRunLaneTimeoutMs(60_000.9)).toBe(
      60_000 + __testing.EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
    );
    expect(__testing.resolveEmbeddedRunLaneTimeoutMs(DEFAULT_AGENT_TIMEOUT_MS + 60_000)).toBe(
      DEFAULT_AGENT_TIMEOUT_MS + 60_000 + __testing.EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
    );
  });

  it("keeps the lane watchdog active when the run timeout is disabled", () => {
    const defaultLaneTimeoutMs =
      DEFAULT_AGENT_TIMEOUT_MS + __testing.EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS;

    expect(__testing.resolveEmbeddedRunLaneTimeoutMs(0)).toBe(defaultLaneTimeoutMs);
    expect(__testing.resolveEmbeddedRunLaneTimeoutMs(-1)).toBe(defaultLaneTimeoutMs);
    expect(__testing.resolveEmbeddedRunLaneTimeoutMs(Number.NaN)).toBe(defaultLaneTimeoutMs);
    expect(__testing.resolveEmbeddedRunLaneTimeoutMs(MAX_TIMER_TIMEOUT_MS)).toBe(
      defaultLaneTimeoutMs,
    );
  });
});
