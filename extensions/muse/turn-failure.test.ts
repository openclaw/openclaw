// A Muse quota failure must be classifiable as a rate limit even when its wording is opaque.
import { describe, expect, it } from "vitest";
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

  it("keeps the typed status reachable through the terminal wrapper's cause", () => {
    const quota = museTurnFailureError({ message: "Tier limit reached", quota: {} }, undefined);
    const wrapped = new Error("Muse Code: Tier limit reached", { cause: quota });

    // The host classifies failover by walking `cause` for a status, so the wrapper must not drop it.
    expect((wrapped.cause as { status?: number }).status).toBe(429);
  });

  it("opaque wording alone carries no typed status", () => {
    // What the harness produced before it kept the typed quota signal: no status for the host to read.
    expect(new Error("Muse Code: Tier limit reached")).not.toHaveProperty("status");
  });

  it("keeps the sign-in and plain messages unchanged", () => {
    expect(
      museTurnFailureError({ kind: "authRequired", message: "not logged in" }, undefined).message,
    ).toContain("muse login");
    expect(museTurnFailureError({ message: "bad request" }, undefined).message).toBe("bad request");
    expect(museTurnFailureError(undefined, "model unavailable").message).toBe("model unavailable");
  });
});
