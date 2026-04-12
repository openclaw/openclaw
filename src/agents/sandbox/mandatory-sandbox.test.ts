import { describe, expect, it } from "vitest";
import {
  requiresMandatorySandbox,
  requiresMandatorySandboxForTier,
} from "./mandatory-sandbox.js";

describe("requiresMandatorySandbox (category)", () => {
  it("forces sandbox for community skills", () => {
    const r = requiresMandatorySandbox("community");
    expect(r.required).toBe(true);
    expect(r.reason).toMatch(/community skills must run in a sandbox/);
    expect(r.defaultNetworkMode).toBe("open");
  });

  it("does not require sandbox for premium skills", () => {
    const r = requiresMandatorySandbox("premium");
    expect(r.required).toBe(false);
  });

  it("does not require sandbox for proprietary skills", () => {
    const r = requiresMandatorySandbox("proprietary");
    expect(r.required).toBe(false);
  });

  it("fails closed for unknown categories", () => {
    const r = requiresMandatorySandbox("random-string");
    expect(r.required).toBe(true);
    expect(r.defaultNetworkMode).toBe("none");
    expect(r.reason).toMatch(/unknown skill category/);
  });
});

describe("requiresMandatorySandboxForTier (cert_tier)", () => {
  it("certified skills are not required to sandbox", () => {
    const r = requiresMandatorySandboxForTier("certified");
    expect(r.required).toBe(false);
    expect(r.defaultNetworkMode).toBe("open");
  });

  it("verified skills are required to sandbox with open network", () => {
    const r = requiresMandatorySandboxForTier("verified");
    expect(r.required).toBe(true);
    expect(r.defaultNetworkMode).toBe("open");
    expect(r.reason).toMatch(/verified skills must run in a mandatory sandbox/);
  });

  it("unverified skills are required to sandbox with NO outbound network", () => {
    const r = requiresMandatorySandboxForTier("unverified");
    expect(r.required).toBe(true);
    expect(r.defaultNetworkMode).toBe("none");
    expect(r.reason).toMatch(/strict sandbox/);
  });

  it("unknown tiers fail closed to strict mode", () => {
    const r = requiresMandatorySandboxForTier("some-new-tier");
    expect(r.required).toBe(true);
    expect(r.defaultNetworkMode).toBe("none");
    expect(r.reason).toMatch(/unknown cert tier/);
  });
});
