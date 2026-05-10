import { describe, expect, it } from "vitest";
import { resolveTrustedExecAllowlist } from "./bash-tools.exec-trusted-env.js";

const FIXTURE_ENV = {
  OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "GH_TOKEN,AWS_ACCESS_KEY_ID,OPENCLAW_GATEWAY_TOKEN,LD_PRELOAD",
};

describe("resolveTrustedExecAllowlist", () => {
  it("returns the operator allowlist when host=gateway, security=full, ask=off", () => {
    const allowlist = resolveTrustedExecAllowlist({
      host: "gateway",
      security: "full",
      ask: "off",
      env: FIXTURE_ENV,
    });

    expect(allowlist).toBeInstanceOf(Set);
    expect(allowlist?.has("GH_TOKEN")).toBe(true);
    expect(allowlist?.has("AWS_ACCESS_KEY_ID")).toBe(true);
    // OPENCLAW_* and everywhere-dangerous keys are filtered by
    // readOperatorInheritedEnvAllowlist itself.
    expect(allowlist?.has("OPENCLAW_GATEWAY_TOKEN")).toBe(false);
    expect(allowlist?.has("LD_PRELOAD")).toBe(false);
  });

  it("returns undefined when host is not gateway", () => {
    expect(
      resolveTrustedExecAllowlist({
        host: "sandbox",
        security: "full",
        ask: "off",
        env: FIXTURE_ENV,
      }),
    ).toBeUndefined();
    expect(
      resolveTrustedExecAllowlist({
        host: "node",
        security: "full",
        ask: "off",
        env: FIXTURE_ENV,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when security is not full", () => {
    expect(
      resolveTrustedExecAllowlist({
        host: "gateway",
        security: "allowlist",
        ask: "off",
        env: FIXTURE_ENV,
      }),
    ).toBeUndefined();
    expect(
      resolveTrustedExecAllowlist({
        host: "gateway",
        security: "deny",
        ask: "off",
        env: FIXTURE_ENV,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when ask is not off", () => {
    expect(
      resolveTrustedExecAllowlist({
        host: "gateway",
        security: "full",
        ask: "on-miss",
        env: FIXTURE_ENV,
      }),
    ).toBeUndefined();
    expect(
      resolveTrustedExecAllowlist({
        host: "gateway",
        security: "full",
        ask: "always",
        env: FIXTURE_ENV,
      }),
    ).toBeUndefined();
  });

  it("returns an empty Set when trusted but OPENCLAW_SERVICE_MANAGED_ENV_KEYS is absent", () => {
    const allowlist = resolveTrustedExecAllowlist({
      host: "gateway",
      security: "full",
      ask: "off",
      env: {},
    });

    expect(allowlist).toBeInstanceOf(Set);
    expect(allowlist?.size).toBe(0);
  });
});
