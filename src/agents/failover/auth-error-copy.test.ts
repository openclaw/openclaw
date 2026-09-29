import { describe, expect, it } from "vitest";
import { findHostManagedAuthFailure } from "./auth-error-copy.js";
import { FailoverError } from "./error.js";

describe("host authentication ownership", () => {
  it("finds the selected host failure through an untyped wrapper", () => {
    const hostFailure = new FailoverError("Unauthorized", {
      reason: "auth",
      authOwner: "host",
    });
    expect(findHostManagedAuthFailure(new Error("Run failed", { cause: hostFailure }))).toBe(
      hostFailure,
    );
  });

  it.each([false, true])("uses the selected typed candidate when wrapped=%s", (wrapped) => {
    const earlierHostFailure = new FailoverError("Unauthorized", {
      reason: "auth",
      authOwner: "host",
    });
    const selectedGatewayFailure = new FailoverError("All models failed", {
      reason: "auth",
      cause: earlierHostFailure,
    });
    const error = wrapped
      ? new Error("Run failed", { cause: selectedGatewayFailure })
      : selectedGatewayFailure;
    expect(findHostManagedAuthFailure(error)).toBeUndefined();
  });
});
