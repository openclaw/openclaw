import { describe, expect, it } from "vitest";
import { isSandboxProvisioningError, toSandboxProvisioningError } from "./provisioning-error.js";

describe("sandbox provisioning errors", () => {
  it("preserves an existing typed error", () => {
    const error = toSandboxProvisioningError(new Error("missing image"), "docker");

    expect(toSandboxProvisioningError(error, "other")).toBe(error);
  });

  it("turns nested permission failures into an actionable sandbox diagnostic", () => {
    const permission = Object.assign(
      new Error("EACCES: permission denied, lstat '/workspace/.openclaw/sandbox-skills'"),
      { code: "EACCES" },
    );
    const wrapped = new Error("path alias escape blocked", { cause: permission });

    expect(toSandboxProvisioningError(wrapped, "docker").message).toBe(
      "Sandbox provisioning could not access the workspace or its generated skill mount directory. Check that the Gateway user can traverse and write the workspace, then retry. Details: path alias escape blocked | EACCES: permission denied, lstat '/workspace/.openclaw/sandbox-skills' | EACCES",
    );
  });

  it("keeps opaque nested errors from breaking provisioning error normalization", () => {
    const opaque = Object.defineProperty(new Error("path alias escape blocked"), "code", {
      get() {
        throw new Error("opaque code");
      },
    });

    expect(toSandboxProvisioningError(opaque, "docker").message).toBe("path alias escape blocked");
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
