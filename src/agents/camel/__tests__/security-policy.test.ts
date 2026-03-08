import { describe, expect, it } from "vitest";
import { resolveCaMeLConfig } from "../config.js";
import { createCapabilities, createDefaultPolicies, createValue } from "../index.js";

function taintedArg(raw: string) {
  return createValue(
    raw,
    createCapabilities({ sources: [{ kind: "tool", toolName: "web_fetch" }] }),
  );
}

describe("camel/security-policy", () => {
  it("denies side-effect tools with tainted args by default", () => {
    const engine = createDefaultPolicies({ enabled: true, mode: "strict", policies: {} });
    const result = engine.checkPolicy("message.send", { to: taintedArg("attacker@evil.com") }, []);

    expect(result).toEqual({
      denied: true,
      reason: expect.stringContaining("tainted"),
    });
  });

  it("allows no-side-effect tools even when tainted", () => {
    const engine = createDefaultPolicies({ enabled: true, mode: "strict", policies: {} });
    const result = engine.checkPolicy("Read", { path: taintedArg("/tmp/file.txt") }, []);

    expect(result).toEqual({ allowed: true });
  });

  it("allows trusted recipients from config", () => {
    const engine = createDefaultPolicies({
      enabled: true,
      mode: "strict",
      policies: {
        trustedRecipients: ["security@openclaw.ai"],
      },
    });

    const result = engine.checkPolicy(
      "message.send",
      { to: taintedArg("security@openclaw.ai") },
      [],
    );
    expect(result).toEqual({ allowed: true });
  });

  it("uses wildcard approval defaults for dotted tool names", () => {
    const config = resolveCaMeLConfig({
      enabled: true,
      mode: "strict",
      policies: {},
    });
    const engine = createDefaultPolicies(config);
    const result = engine.checkPolicy("message.send", { to: taintedArg("attacker@evil.com") }, []);

    expect(result).toEqual({
      denied: true,
      reason: expect.stringContaining("requires explicit approval"),
    });
  });
});
