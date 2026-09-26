import { describe, expect, it } from "vitest";
import { isSandboxProvisioningError, toSandboxProvisioningError } from "./provisioning-error.js";

describe("sandbox provisioning errors", () => {
  it("preserves an existing typed error", () => {
    const error = toSandboxProvisioningError(new Error("missing image"), "docker");

    expect(toSandboxProvisioningError(error, "other")).toBe(error);
  });

  it("recognizes markers beside opaque getters and through cyclic wrappers", () => {
    const error = toSandboxProvisioningError(new Error("backend unavailable"), "docker");
    const wrapper = Object.defineProperty({ errors: [error] }, "cause", {
      get() {
        throw new Error("opaque cause");
      },
    });
    expect(isSandboxProvisioningError(wrapper)).toBe(true);
    const cycle = { error: undefined as unknown, errors: [wrapper] };
    cycle.error = cycle;
    expect(isSandboxProvisioningError(cycle)).toBe(true);
    expect(isSandboxProvisioningError({ errors: [cycle, null] })).toBe(true);
    wrapper.errors.length = 0;
    expect(isSandboxProvisioningError(cycle)).toBe(false);
  });

  it("recognizes serialized markers without inferring them from message text", () => {
    expect(
      isSandboxProvisioningError({
        name: "SandboxProvisioningError",
        code: "sandbox_provisioning",
      }),
    ).toBe(true);
    expect(isSandboxProvisioningError(new Error("sandbox_provisioning"))).toBe(false);
  });

  it("recognizes provisioning failures through wrapper causes", () => {
    const provisioningError = toSandboxProvisioningError(
      new Error("backend unavailable"),
      "docker",
    );
    const wrapped = new Error("agent setup failed", { cause: provisioningError });

    expect(isSandboxProvisioningError(wrapped)).toBe(true);
    expect(isSandboxProvisioningError(new Error("provider failed"))).toBe(false);
  });
});
