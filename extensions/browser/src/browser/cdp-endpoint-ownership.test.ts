// Browser tests cover CDP endpoint ownership admission used by Playwright defaults.
import type { BrowserConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  isExternallyOwnedCdpEndpoint,
  publishCdpEndpointOwnership,
} from "./cdp-endpoint-ownership.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import type { ResolvedBrowserProfile } from "./profile.types.js";
import { createBrowserRouteContext, type BrowserServerState } from "./server-context.js";

// Throwaway high ports keep these fixtures clear of the loopback URLs other
// browser suites reserve (9222/9333 for CDP, 19441-19445 for extension relays)
// so the module-level registry never leaks across files through a shared
// endpoint key.
const ATTACH_ONLY_PORT = 19422;
const REMOTE_PORT = 19423;
const EXTENSION_PORT = 19424;
const REPUBLISH_PORT = 19425;
const PLAIN_KEY_PORT = 19444;
const CREDENTIALED_KEY_PORT = 19445;
const ATTACH_ADMISSION_PORT = 19446;
const MANAGED_ADMISSION_PORT = 19447;
const SANDBOX_SHAPED_PORT = 19448;
const EXISTING_SESSION_PORT = 19449;
const LAUNCHED_ADMISSION_PORT = 19450;
const ATTACH_ADMISSION_URL = `http://127.0.0.1:${ATTACH_ADMISSION_PORT}`;

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function admitProfile(
  config: BrowserConfig,
  profileName: string,
  launchedByOpenClaw = false,
): ResolvedBrowserProfile {
  const resolved = resolveBrowserConfig(config);
  // Bridge runtimes mark the resolved config after resolution, exactly like the
  // sandbox container browser and the worker browser launcher do.
  if (launchedByOpenClaw) {
    resolved.launchedByOpenClaw = true;
  }
  return requireValue(resolveProfile(resolved, profileName), `${profileName} profile missing`);
}

describe("CDP endpoint ownership", () => {
  it("publishes the managed fact for the default openclaw profile", () => {
    const profile = admitProfile({}, "openclaw");
    publishCdpEndpointOwnership(profile);

    expect(isExternallyOwnedCdpEndpoint(profile.cdpUrl)).toBe(false);
  });

  it("marks a loopback attach-only profile as externally owned", () => {
    const profile = admitProfile(
      {
        profiles: {
          attach: {
            driver: "openclaw",
            attachOnly: true,
            cdpUrl: `http://127.0.0.1:${ATTACH_ONLY_PORT}`,
          },
        },
      },
      "attach",
    );
    publishCdpEndpointOwnership(profile);

    expect(isExternallyOwnedCdpEndpoint(`http://127.0.0.1:${ATTACH_ONLY_PORT}`)).toBe(true);
  });

  it("marks an explicit non-loopback endpoint as externally owned", () => {
    const cdpUrl = `https://browser.example:${REMOTE_PORT}/devtools/browser`;
    const profile = admitProfile(
      { profiles: { remote: { driver: "openclaw", cdpUrl } } },
      "remote",
    );
    publishCdpEndpointOwnership(profile);

    expect(isExternallyOwnedCdpEndpoint(cdpUrl)).toBe(true);
  });

  // The extension-relay path connects through its own relay endpoint and keeps
  // Playwright's default-context overrides, so the fact must not mark it external.
  it("keeps the managed fact for an extension-driver relay profile", () => {
    const profile = admitProfile(
      { profiles: { ext: { driver: "extension", cdpPort: EXTENSION_PORT } } },
      "ext",
    );
    publishCdpEndpointOwnership(profile);

    expect(profile.driver).toBe("extension");
    expect(isExternallyOwnedCdpEndpoint(`http://127.0.0.1:${EXTENSION_PORT}`)).toBe(false);
  });

  // The chrome-mcp existing-session path resolves through Chrome MCP instead of
  // the CDP connect path, so its ownership fact must stay managed.
  it("keeps the managed fact for an existing-session profile", () => {
    const cdpUrl = `http://127.0.0.1:${EXISTING_SESSION_PORT}`;
    const profile = admitProfile(
      { profiles: { live: { driver: "existing-session", attachOnly: true, cdpUrl } } },
      "live",
    );
    publishCdpEndpointOwnership(profile);

    expect(profile.driver).toBe("existing-session");
    expect(isExternallyOwnedCdpEndpoint(cdpUrl)).toBe(false);
  });

  // Sandbox container browsers attach over CDP to a browser the sandbox runtime
  // launched, so the resolved config declares launchedByOpenClaw.
  it("keeps the managed fact for a launched bridge browser that attaches over CDP", () => {
    const cdpUrl = `http://127.0.0.1:${SANDBOX_SHAPED_PORT}`;
    const config: BrowserConfig = {
      profiles: { sandbox: { driver: "openclaw", attachOnly: true, cdpUrl } },
    };
    const admitted = admitProfile(config, "sandbox");
    publishCdpEndpointOwnership(admitted);
    expect(isExternallyOwnedCdpEndpoint(cdpUrl)).toBe(true);

    const launched = admitProfile(config, "sandbox", true);
    expect(launched.launchedByOpenClaw).toBe(true);
    publishCdpEndpointOwnership(launched);

    expect(isExternallyOwnedCdpEndpoint(cdpUrl)).toBe(false);
  });

  it("normalises credentials, whitespace, and trailing slashes into one endpoint key", () => {
    const plain = admitProfile(
      {
        profiles: {
          plain: {
            driver: "openclaw",
            attachOnly: true,
            cdpUrl: `http://127.0.0.1:${PLAIN_KEY_PORT}/devtools/browser`,
          },
        },
      },
      "plain",
    );
    const credentialed = admitProfile(
      {
        profiles: {
          credentialed: {
            driver: "openclaw",
            attachOnly: true,
            cdpUrl: `http://user:pass@127.0.0.1:${CREDENTIALED_KEY_PORT}/devtools/browser`,
          },
        },
      },
      "credentialed",
    );
    publishCdpEndpointOwnership(plain);
    publishCdpEndpointOwnership(credentialed);

    expect(
      isExternallyOwnedCdpEndpoint(`http://127.0.0.1:${PLAIN_KEY_PORT}/devtools/browser`),
    ).toBe(true);
    expect(
      isExternallyOwnedCdpEndpoint(`http://127.0.0.1:${PLAIN_KEY_PORT}/devtools/browser/`),
    ).toBe(true);
    expect(
      isExternallyOwnedCdpEndpoint(`http://user:pass@127.0.0.1:${PLAIN_KEY_PORT}/devtools/browser`),
    ).toBe(true);
    expect(
      isExternallyOwnedCdpEndpoint(`  http://127.0.0.1:${PLAIN_KEY_PORT}/devtools/browser  `),
    ).toBe(true);
    // The credentialed publish is queryable without credentials.
    expect(isExternallyOwnedCdpEndpoint(`http://127.0.0.1:${CREDENTIALED_KEY_PORT}`)).toBe(false);
    expect(
      isExternallyOwnedCdpEndpoint(`http://127.0.0.1:${CREDENTIALED_KEY_PORT}/devtools/browser`),
    ).toBe(true);
  });

  // An unpublished endpoint stays unknown, so the connect path keeps Playwright's
  // default-context overrides instead of guessing an owner from the URL.
  it("keeps Playwright defaults for an endpoint that was never published", () => {
    expect(isExternallyOwnedCdpEndpoint("http://127.0.0.1:19499")).toBe(false);
  });

  it("keeps the latest fact when one endpoint is published twice", () => {
    const cdpUrl = `http://127.0.0.1:${REPUBLISH_PORT}`;
    const external = admitProfile(
      {
        profiles: {
          external: { driver: "openclaw", attachOnly: true, cdpUrl },
        },
      },
      "external",
    );
    const managed = admitProfile(
      { profiles: { managed: { driver: "openclaw", cdpUrl } } },
      "managed",
    );
    publishCdpEndpointOwnership(external);
    expect(isExternallyOwnedCdpEndpoint(cdpUrl)).toBe(true);

    publishCdpEndpointOwnership(managed);

    expect(managed.attachOnly).toBe(false);
    expect(isExternallyOwnedCdpEndpoint(cdpUrl)).toBe(false);
  });

  // Pins the production admission→publish wiring: admitting a profile through
  // createBrowserRouteContext().forProfile() must publish endpoint ownership from
  // getOrCreateProfileRuntime, so the CDP connect path cannot silently keep
  // Playwright's default-context overrides for a browser OpenClaw did not launch.
  // This test must fail if that publish call is removed from getOrCreateProfileRuntime,
  // and it deliberately never calls publishCdpEndpointOwnership by hand.
  it("publishes endpoint ownership from route-context profile admission", () => {
    const state: BrowserServerState = {
      port: 0,
      resolved: resolveBrowserConfig({
        defaultProfile: "attach",
        profiles: {
          attach: { driver: "openclaw", attachOnly: true, cdpUrl: ATTACH_ADMISSION_URL },
          managed: { cdpPort: MANAGED_ADMISSION_PORT, color: "#123456" },
        },
      }),
      profiles: new Map(),
    };
    const ctx = createBrowserRouteContext({ getState: () => state });

    // No profile has been admitted yet, so the endpoint is still unknown.
    expect(isExternallyOwnedCdpEndpoint(ATTACH_ADMISSION_URL)).toBe(false);

    const attach = ctx.forProfile("attach");

    expect(attach.profile.cdpUrl).toBe(ATTACH_ADMISSION_URL);
    expect(isExternallyOwnedCdpEndpoint(ATTACH_ADMISSION_URL)).toBe(true);

    // Admitting the managed profile must not inherit the attach-only external fact.
    const managed = ctx.forProfile("managed");
    const managedUrl = managed.profile.cdpUrl;

    expect(managedUrl).toBe(`http://127.0.0.1:${MANAGED_ADMISSION_PORT}`);
    expect(isExternallyOwnedCdpEndpoint(managedUrl)).toBe(false);
  });

  // Pins the whole launched-bridge chain for real: the sandbox/worker producer
  // marks the resolved config, resolveProfile carries it to the profile, and
  // admission publishes the managed fact for the attach-only CDP endpoint.
  it("keeps Playwright defaults for a launched bridge profile admitted by the route context", () => {
    const cdpUrl = `http://127.0.0.1:${LAUNCHED_ADMISSION_PORT}`;
    const state: BrowserServerState = {
      port: 0,
      resolved: resolveBrowserConfig({
        profiles: { sandbox: { driver: "openclaw", attachOnly: true, cdpUrl } },
      }),
      profiles: new Map(),
    };
    state.resolved.launchedByOpenClaw = true;
    const ctx = createBrowserRouteContext({ getState: () => state });

    const sandbox = ctx.forProfile("sandbox");

    expect(sandbox.profile.launchedByOpenClaw).toBe(true);
    expect(sandbox.profile.attachOnly).toBe(true);
    expect(isExternallyOwnedCdpEndpoint(cdpUrl)).toBe(false);
  });
});
