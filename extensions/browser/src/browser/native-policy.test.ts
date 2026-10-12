import { describe, expect, it } from "vitest";
import { parseNativePolicyValues, type NativeBrowserPolicy } from "./native-policy.js";

const identity = {
  browser: "Google Chrome",
  version: "144.0.7559.96",
  os: "Linux",
  executablePath: "/opt/google/chrome/chrome",
};

describe("native policy inspection", () => {
  describe.each([
    {
      version: "144.0.7559.96",
      exportPolicies: (policies: Record<string, NativeBrowserPolicy>) => ({
        policyIds: ["chrome"],
        policyValues: { chrome: { name: "Chrome Policies", policies } },
      }),
    },
    {
      version: "154.0.8037.97",
      exportPolicies: (policies: Record<string, NativeBrowserPolicy>) => ({
        policyGroups: {
          chrome: { name: "Chrome Policies", policies },
          extensionInstall: { name: "Extension Install Policies", policies: {} },
          precedence: {
            name: "Policy Precedence",
            policies: {},
            precedenceOrder: ["Platform machine", "Cloud machine", "Platform user", "Cloud user"],
          },
        },
        policyIdsPresentationOrder: ["chrome", "precedence", "extensionInstall"],
      }),
    },
  ])("Chrome $version export", ({ version, exportPolicies }) => {
    const browserIdentity = { ...identity, version };

    it("reports browser-confirmed empty policy", () => {
      expect(parseNativePolicyValues(browserIdentity, exportPolicies({}))).toMatchObject({
        state: "none",
        ...browserIdentity,
        policies: {},
      });
    });

    it("preserves native provider diagnostics and precedence without reinterpreting rules", () => {
      const policy = {
        value: ["*"],
        level: "mandatory",
        scope: "machine",
        source: "platform",
        warning: "conflicting policy",
        conflicts: [{ value: ["example.com"], source: "cloud" }],
      };
      expect(
        parseNativePolicyValues(browserIdentity, exportPolicies({ URLBlocklist: policy })),
      ).toMatchObject({ state: "effective", policies: { URLBlocklist: policy } });
    });
  });

  it("distinguishes missing Chrome groups from empty policy", () => {
    expect(() => parseNativePolicyValues(identity, { policyValues: {} })).toThrow("unsupported");
    expect(() => parseNativePolicyValues(identity, { policyGroups: {} })).toThrow("unsupported");
  });
});
