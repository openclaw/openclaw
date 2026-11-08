import { describe, expect, it } from "vitest";
import {
  describeSignalRateLimitRecovery,
  readSignalRateLimitRecovery,
} from "./rate-limit-recovery.js";

// Verbatim shape from signal-cli's SignalJsonRpcCommandHandler#getErrorDataNode.
const envelope = (results: unknown[]) => ({ response: { timestamp: 1762000000000, results } });

describe("readSignalRateLimitRecovery", () => {
  it("reads retry timing from a rate-limit failure", () => {
    expect(
      readSignalRateLimitRecovery(
        envelope([{ type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 61 }]),
      ),
    ).toEqual({ retryAfterSeconds: 61, captchaRequired: false });
  });

  it("uses the largest retry window across recipients", () => {
    expect(
      readSignalRateLimitRecovery(
        envelope([
          { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 30 },
          { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 120 },
        ]),
      ),
    ).toEqual({ retryAfterSeconds: 120, captchaRequired: false });
  });

  it("flags a captcha challenge without exposing the token", () => {
    const recovery = readSignalRateLimitRecovery(
      envelope([{ type: "RATE_LIMIT_FAILURE", token: "challenge-token-abc" }]),
    );
    expect(recovery).toEqual({ captchaRequired: true });
    expect(JSON.stringify(recovery)).not.toContain("challenge-token-abc");
  });

  it("ignores envelopes without a rate-limit failure", () => {
    expect(readSignalRateLimitRecovery(envelope([{ type: "SUCCESS" }]))).toBeNull();
    expect(readSignalRateLimitRecovery(undefined)).toBeNull();
    expect(readSignalRateLimitRecovery({ response: { results: "nope" } })).toBeNull();
  });

  it("drops non-positive or non-numeric retry timings", () => {
    expect(
      readSignalRateLimitRecovery(
        envelope([{ type: "RATE_LIMIT_FAILURE", retryAfterSeconds: -5 }]),
      ),
    ).toEqual({ captchaRequired: false });
    expect(
      readSignalRateLimitRecovery(
        envelope([{ type: "RATE_LIMIT_FAILURE", retryAfterSeconds: "soon" }]),
      ),
    ).toEqual({ captchaRequired: false });
  });
});

describe("describeSignalRateLimitRecovery", () => {
  it("leaves unrelated errors untouched", () => {
    const fallback = "Signal RPC -5: Failed to send message due to rate limiting";
    expect(describeSignalRateLimitRecovery(undefined, fallback)).toBe(fallback);
  });

  it("appends retry and captcha guidance for a challenge", () => {
    const described = describeSignalRateLimitRecovery(
      envelope([{ type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 61.4, token: "t0k3n" }]),
      "Signal RPC -5: remote error",
    );
    expect(described).toBe(
      "Signal RPC -5: remote error (rate limited: retry after 62s; captcha proof required; " +
        "run `signal-cli submitRateLimitChallenge` before sending again)",
    );
    expect(described).not.toContain("t0k3n");
  });

  it("still names a rate limit when only the type is present", () => {
    expect(
      describeSignalRateLimitRecovery(
        envelope([{ type: "RATE_LIMIT_FAILURE" }]),
        "Signal RPC -5: remote error",
      ),
    ).toBe("Signal RPC -5: remote error (rate limited)");
  });
});
