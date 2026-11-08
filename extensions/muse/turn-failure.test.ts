// A Muse quota failure must be classifiable as a rate limit even when its wording is opaque.
import { describe, expect, it } from "vitest";
import { describeFailoverError } from "../../src/agents/failover-error.js";
import { MuseQuotaLimitError, museTurnFailureError } from "./turn-failure.js";

describe("museTurnFailureError", () => {
  it("keeps the typed quota signal as a 429", () => {
    const error = museTurnFailureError(
      {
        message: "quota exhausted",
        quota: { limitKind: "tierLimit", resetsAtMs: Date.UTC(2026, 10, 8, 10, 0) },
        retryable: false,
      },
      undefined,
    );

    expect(error).toBeInstanceOf(MuseQuotaLimitError);
    expect((error as MuseQuotaLimitError).status).toBe(429);
    expect(error.message).toContain("quota exhausted");
    expect(error.message).toContain("2026-11-08T10:00:00.000Z");
  });

  it("classifies an opaque quota message as a rate limit through the failover chain", () => {
    const quota = museTurnFailureError({ message: "Tier limit reached", quota: {} }, undefined);
    const wrapped = new Error("Muse Code: Tier limit reached", { cause: quota });

    expect(describeFailoverError(wrapped)).toMatchObject({ reason: "rate_limit", status: 429 });
  });

  it("opaque wording alone does not classify as a rate limit", () => {
    // What the harness produced before it kept the typed quota signal.
    expect(describeFailoverError(new Error("Muse Code: Tier limit reached")).reason).toBe(
      undefined,
    );
  });

  it("keeps the sign-in and plain messages unchanged", () => {
    expect(
      museTurnFailureError({ kind: "authRequired", message: "not logged in" }, undefined).message,
    ).toContain("muse login");
    expect(museTurnFailureError({ message: "bad request" }, undefined).message).toBe("bad request");
    expect(museTurnFailureError(undefined, "model unavailable").message).toBe("model unavailable");
  });
});
