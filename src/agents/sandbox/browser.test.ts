import { describe, expect, it } from "vitest";
import { isPrivateNetworkAllowedByPolicy } from "../../infra/net/ssrf.js";
import { buildSandboxBrowserResolvedConfig } from "./browser.js";

describe("buildSandboxBrowserResolvedConfig", () => {
  it("includes ssrfPolicy when shareNetworkNamespace is true", () => {
    const config = buildSandboxBrowserResolvedConfig({
      controlPort: 9222,
      cdpPort: 9223,
      headless: true,
      evaluateEnabled: false,
      shareNetworkNamespace: true,
    });

    expect(config.ssrfPolicy).toBeDefined();
    expect(config.ssrfPolicy?.dangerouslyAllowPrivateNetwork).toBe(true);
  });

  it("ssrfPolicy passes isPrivateNetworkAllowedByPolicy when namespace sharing enabled", () => {
    const config = buildSandboxBrowserResolvedConfig({
      controlPort: 9222,
      cdpPort: 9223,
      headless: true,
      evaluateEnabled: false,
      shareNetworkNamespace: true,
    });

    expect(isPrivateNetworkAllowedByPolicy(config.ssrfPolicy)).toBe(true);
  });

  it("does not include ssrfPolicy when shareNetworkNamespace is false", () => {
    const config = buildSandboxBrowserResolvedConfig({
      controlPort: 9222,
      cdpPort: 9223,
      headless: true,
      evaluateEnabled: false,
      shareNetworkNamespace: false,
    });

    expect(config.ssrfPolicy).toBeUndefined();
  });

  it("does not include ssrfPolicy when shareNetworkNamespace is omitted", () => {
    const config = buildSandboxBrowserResolvedConfig({
      controlPort: 9222,
      cdpPort: 9223,
      headless: true,
      evaluateEnabled: false,
    });

    expect(config.ssrfPolicy).toBeUndefined();
  });
});
