import { describe, expect, it } from "vitest";
import { verifyNativeBrowserPolicy } from "./native-policy-setup.js";
import type { NativeBrowserPolicyReport } from "./native-policy.js";

const report: Extract<NativeBrowserPolicyReport, { policies: unknown }> = {
  state: "none",
  browser: "Google Chrome",
  version: "144.0.7559.96",
  os: "Linux",
  executablePath: "/opt/google/chrome/chrome",
  policies: {},
  observedAt: 1,
};
const loaded = { level: "mandatory", scope: "machine", source: "platform" };

describe("native policy verification", () => {
  it("confirms native dictionary and immediate dictionary-list display serialization", () => {
    const policies = {
      ProxySettings: { ProxyMode: "direct" },
      ManagedBookmarks: [{ name: "Example", url: "https://example.com" }],
    };
    expect(
      verifyNativeBrowserPolicy({
        policies,
        controlReady: true,
        report: {
          ...report,
          state: "effective",
          policies: {
            ProxySettings: { ...loaded, value: '{ "ProxyMode": "direct" }' },
            ManagedBookmarks: {
              ...loaded,
              value: ['{ "name": "Example", "url": "https://example.com" }'],
            },
          },
        },
      }),
    ).toMatchObject({ state: "verified", issues: [] });
  });
});
