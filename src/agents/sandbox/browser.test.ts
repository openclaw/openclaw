import { describe, expect, it } from "vitest";
import { isPrivateNetworkAllowedByPolicy } from "../../infra/net/ssrf.js";
import { buildSandboxBrowserResolvedConfig } from "./browser.js";

describe("buildSandboxBrowserResolvedConfig", () => {
  it("includes ssrfPolicy that allows private network (trusted-network mode)", () => {
    const config = buildSandboxBrowserResolvedConfig({
      controlPort: 9222,
      cdpPort: 9223,
      headless: true,
      evaluateEnabled: false,
    });

    expect(config.ssrfPolicy).toBeDefined();
    expect(config.ssrfPolicy?.dangerouslyAllowPrivateNetwork).toBe(true);
  });

  it("ssrfPolicy passes isPrivateNetworkAllowedByPolicy check", () => {
    const config = buildSandboxBrowserResolvedConfig({
      controlPort: 9222,
      cdpPort: 9223,
      headless: true,
      evaluateEnabled: false,
    });

    expect(isPrivateNetworkAllowedByPolicy(config.ssrfPolicy)).toBe(true);
  });
});
