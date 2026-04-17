import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../auth-profiles.js";
import {
  ClaudeSdkCredentialUnavailableError,
  classifySdkFailureForRotation,
  resolveClaudeSdkCredentialMode,
  resolveSdkCredential,
} from "./transport-middleware.js";

describe("resolveClaudeSdkCredentialMode", () => {
  it("defaults to subscription (the safe, non-metered default)", () => {
    expect(resolveClaudeSdkCredentialMode(undefined)).toBe("subscription");
    expect(resolveClaudeSdkCredentialMode({})).toBe("subscription");
  });

  it("honors explicit profile opt-in", () => {
    expect(resolveClaudeSdkCredentialMode({ credential: "profile" })).toBe("profile");
  });

  it("treats explicit subscription same as default", () => {
    expect(resolveClaudeSdkCredentialMode({ credential: "subscription" })).toBe("subscription");
  });
});

describe("classifySdkFailureForRotation", () => {
  it("rotates on 401 unauthorized", () => {
    expect(classifySdkFailureForRotation(new Error("HTTP 401 Unauthorized"))).toEqual({
      kind: "rotate",
      reason: "auth",
    });
  });

  it("rotates on rate-limit errors", () => {
    expect(classifySdkFailureForRotation(new Error("HTTP 429 rate limit exceeded"))).toEqual({
      kind: "rotate",
      reason: "rate_limit",
    });
  });

  it("does not rotate on generic failures", () => {
    expect(classifySdkFailureForRotation(new Error("network timeout"))).toEqual({
      kind: "do_not_rotate",
    });
  });
});

describe("resolveSdkCredential (subscription mode)", () => {
  const emptyStore: AuthProfileStore = {
    version: 1,
    profiles: {},
  } as AuthProfileStore;

  it("returns an empty env in subscription mode (SDK inherits claude login)", async () => {
    const result = await resolveSdkCredential({
      store: emptyStore,
      runtimeConfig: { credential: "subscription" },
    });
    expect(result.source).toBe("subscription");
    expect(result.env).toEqual({});
    expect(result.profileId).toBeUndefined();
  });

  it("returns subscription even when no config is provided (does not touch cfg)", async () => {
    const result = await resolveSdkCredential({
      store: emptyStore,
      runtimeConfig: undefined,
    });
    expect(result.source).toBe("subscription");
  });
});

describe("resolveSdkCredential (profile mode error paths)", () => {
  const emptyStore: AuthProfileStore = {
    version: 1,
    profiles: {},
  } as AuthProfileStore;

  it("throws ClaudeSdkCredentialUnavailableError when no cfg and no pinned profile are given", async () => {
    await expect(
      resolveSdkCredential({
        store: emptyStore,
        runtimeConfig: { credential: "profile" },
      }),
    ).rejects.toBeInstanceOf(ClaudeSdkCredentialUnavailableError);
  });
});
