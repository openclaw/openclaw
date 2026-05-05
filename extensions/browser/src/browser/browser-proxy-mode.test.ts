import { describe, expect, it } from "vitest";
import {
  hasChromeProxyControlArg,
  hasExplicitChromeProxyRoutingArg,
  omitChromeProxyEnv,
  resolveBrowserNavigationProxyMode,
} from "./browser-proxy-mode.js";

describe("browser proxy mode", () => {
  it("detects Chrome proxy-routing args separately from direct proxy controls", () => {
    expect(hasChromeProxyControlArg(["--no-proxy-server"])).toBe(true);
    expect(hasExplicitChromeProxyRoutingArg(["--no-proxy-server"])).toBe(false);
    expect(hasExplicitChromeProxyRoutingArg(["--proxy-server=http://127.0.0.1:7890"])).toBe(true);
    expect(hasExplicitChromeProxyRoutingArg(["--proxy-pac-url", "http://proxy.test/pac"])).toBe(
      true,
    );
  });

  it("removes proxy env before launching managed Chrome", () => {
    const env = omitChromeProxyEnv({
      HTTP_PROXY: "http://proxy.test:8080",
      HTTPS_PROXY: "http://proxy.test:8443",
      ALL_PROXY: "socks5://proxy.test:1080",
      NO_PROXY: "localhost",
      PATH: "/usr/bin",
      http_proxy: "http://lower.test:8080",
      no_proxy: "127.0.0.1",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("marks only managed local Chrome with explicit proxy routing as proxy-routed", () => {
    const resolved = { extraArgs: ["--proxy-server=http://127.0.0.1:7890"] };
    expect(
      resolveBrowserNavigationProxyMode({
        resolved,
        profile: { driver: "openclaw", cdpIsLoopback: true },
      }),
    ).toBe("explicit-browser-proxy");
    expect(
      resolveBrowserNavigationProxyMode({
        resolved,
        profile: { driver: "openclaw", cdpIsLoopback: false },
      }),
    ).toBe("direct");
  });

  it("marks non-openclaw drivers as external-browser-proxy so Node-side SSRF skips DNS", () => {
    // `existing-session` drivers use the host browser's own network stack
    // (system proxy, PAC, VPN). Node's `getaddrinfo` does not reflect where
    // the browser actually connects, so DNS-to-IP SSRF checks are meaningless
    // here. We mark these profiles so the navigation guard takes the external
    // proxy path (skip DNS check, keep hostname denylist).
    expect(
      resolveBrowserNavigationProxyMode({
        resolved: { extraArgs: [] },
        profile: { driver: "existing-session", cdpIsLoopback: true },
      }),
    ).toBe("external-browser-proxy");
    expect(
      resolveBrowserNavigationProxyMode({
        resolved: { extraArgs: ["--proxy-server=http://127.0.0.1:7890"] },
        profile: { driver: "existing-session", cdpIsLoopback: false },
      }),
    ).toBe("external-browser-proxy");
  });
});
