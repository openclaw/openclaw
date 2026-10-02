import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from "node:dns";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { LookupFn } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertChromeMcpCdpTransportAllowed,
  resolveCdpReachabilityPolicy,
} from "./cdp-reachability-policy.js";
import { resolveCdpReachabilityTimeouts } from "./cdp-timeouts.js";
import { resolveBrowserConfig, resolveProfile, type ResolvedBrowserProfile } from "./config.js";
import { assertBrowserNavigationAllowed } from "./navigation-guard.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

import {
  assertCdpEndpointAllowed,
  fetchJson,
  fetchOk,
  resolveCdpTabOwnership,
  scopeCdpPolicyToConfiguredEndpoint,
} from "./cdp.helpers.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";

const remoteOwnership = {
  profileName: "remote",
  cdpUrl: "https://1.1.1.1",
  nativeTargetId: "TARGET-1",
};
const strictRemotePolicy = {
  dangerouslyAllowPrivateNetwork: false,
  allowedHostnames: ["1.1.1.1"],
};
const { resolvePinnedHostnameWithPolicy } = await vi.importActual<
  typeof import("openclaw/plugin-sdk/security-runtime")
>("openclaw/plugin-sdk/security-runtime");

function mockResponse(response: Response) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
  return release;
}

function mockVersion(webSocketDebuggerUrl: string) {
  return mockResponse(new Response(JSON.stringify({ webSocketDebuggerUrl })));
}

function createLookupFn(address: string): LookupFn {
  const result: LookupAddress = { address, family: address.includes(":") ? 6 : 4 };
  function lookup(_hostname: string, family: number): Promise<LookupAddress>;
  function lookup(_hostname: string, options: LookupOneOptions): Promise<LookupAddress>;
  function lookup(_hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
  function lookup(
    _hostname: string,
    options: LookupOptions,
  ): Promise<LookupAddress | LookupAddress[]>;
  function lookup(_hostname: string): Promise<LookupAddress>;
  async function lookup(_hostname: string, options?: number | LookupOptions) {
    return typeof options === "object" && options.all ? [result] : result;
  }
  return lookup;
}

afterEach(() => fetchWithSsrFGuardMock.mockReset());

describe("CDP discovery and ownership", () => {
  it("rejects oversized CDP JSON responses before parsing", async () => {
    const release = mockResponse(new Response(new Uint8Array(16 * 1024 * 1024 + 1)));
    await expect(fetchJson("http://127.0.0.1:9222/json/version")).rejects.toThrow(
      "cdp-json: JSON response exceeds 16777216 bytes",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("adds exact loopback hosts to the CDP hostname allowlist", async () => {
    await expect(
      assertCdpEndpointAllowed("http://127.0.0.1:9222/json/version", {
        dangerouslyAllowPrivateNetwork: false,
        allowedHostnames: ["*.corp.example"],
      }),
    ).resolves.toEqual(
      expect.objectContaining({ hostname: "127.0.0.1", lookup: expect.any(Function) }),
    );
  });

  it("replaces navigation grants with the exact loopback CDP HTTP host", async () => {
    mockResponse(new Response());
    await fetchOk("http://127.0.0.1:9222/json/version", undefined, undefined, {
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: ["*.corp.example"],
    });
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy).toEqual({
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: ["127.0.0.1"],
    });
  });

  it("allows a discovered endpoint on the configured loopback CDP host", async () => {
    await expect(
      assertCdpEndpointAllowed(
        "ws://127.0.0.1:9222/devtools/browser/local",
        scopeCdpPolicyToConfiguredEndpoint("http://127.0.0.1:9222", {}),
        { source: "discovered", configuredUrl: "http://127.0.0.1:9222" },
      ),
    ).resolves.toEqual(
      expect.objectContaining({ hostname: "127.0.0.1", lookup: expect.any(Function) }),
    );
  });

  it("preserves broad private authority permission through exact-host scoping", async () => {
    const policy = scopeCdpPolicyToConfiguredEndpoint("http://127.0.0.1:9222", {
      allowPrivateNetwork: true,
    });
    await expect(
      assertCdpEndpointAllowed("ws://127.0.0.1:9333/devtools/browser/local", policy, {
        source: "discovered",
        configuredUrl: "http://127.0.0.1:9222",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ hostname: "127.0.0.1", lookup: expect.any(Function) }),
    );
  });

  it("does not turn a strict remote CDP hostname into a private-network grant", async () => {
    const policy = { dangerouslyAllowPrivateNetwork: false };
    const scoped = scopeCdpPolicyToConfiguredEndpoint("https://browser.example:9222", policy);
    expect(scoped).toBe(policy);
    await expect(
      resolvePinnedHostnameWithPolicy("browser.example", {
        policy: scoped,
        lookupFn: createLookupFn("10.0.0.8"),
      }),
    ).rejects.toThrow(/private\/internal\/special-use ip address/i);
  });

  it("keeps explicit remote CDP hostname grants available", async () => {
    const policy = { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["browser.example"] };
    const scoped = scopeCdpPolicyToConfiguredEndpoint("https://browser.example:9222", policy);
    expect(scoped).toEqual(policy);
    await expect(
      resolvePinnedHostnameWithPolicy("browser.example", {
        policy: scoped,
        lookupFn: createLookupFn("10.0.0.8"),
      }),
    ).resolves.toEqual(expect.objectContaining({ addresses: ["10.0.0.8"] }));
  });

  it("blocks a discovered endpoint on another port in strict SSRF mode", async () => {
    await expect(
      assertCdpEndpointAllowed(
        "ws://127.0.0.1:22/devtools/browser/local",
        scopeCdpPolicyToConfiguredEndpoint("http://127.0.0.1:9222", {}),
        { source: "discovered", configuredUrl: "http://127.0.0.1:9222" },
      ),
    ).rejects.toThrow("browser endpoint blocked by policy");
  });

  it("keeps browser-instance fingerprints on the advertised websocket identity", async () => {
    const release = mockVersion("ws://127.0.0.1:9222/devtools/browser/BROWSER-SIDECAR");
    await expect(
      resolveCdpTabOwnership({
        ...remoteOwnership,
        ssrfPolicy: strictRemotePolicy,
      }),
    ).resolves.toMatchObject({
      status: "durable",
      nativeTargetId: "TARGET-1",
      browserInstanceFingerprint:
        "sha256:6eb6cb69267d17a1f2fbf755b1b5c681ddd023c458f6e0f14b3f30848c566ee3",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy).toBe(strictRemotePolicy);
  });

  it("classifies malformed discovered websocket URLs as non-durable", async () => {
    mockVersion("not-a-url");
    await expect(resolveCdpTabOwnership(remoteOwnership)).resolves.toEqual({
      status: "non-durable",
      reason: "browser-identity-unavailable",
    });
  });

  it("still blocks ownership when discovery advertises a different remote authority", async () => {
    mockVersion("ws://evil.example:9223/devtools/browser/BROWSER-SIDECAR");
    await expect(
      resolveCdpTabOwnership({ ...remoteOwnership, ssrfPolicy: strictRemotePolicy }),
    ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
  });

  it("classifies browser identity network failures without hiding caller aborts", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("version lookup timed out"));
    await expect(resolveCdpTabOwnership(remoteOwnership)).resolves.toEqual({
      status: "non-durable",
      reason: "browser-identity-lookup-failed",
    });
    const controller = new AbortController();
    const abortError = new Error("caller stopped ownership lookup");
    fetchWithSsrFGuardMock.mockImplementationOnce(
      async ({ signal }: { signal: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            const reason: unknown = signal.reason;
            reject(reason instanceof Error ? reason : new Error("ownership lookup aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
    );
    const pending = resolveCdpTabOwnership({ ...remoteOwnership, signal: controller.signal });
    controller.abort(abortError);
    await expect(pending).rejects.toBe(abortError);
  });
});

describe("resolveCdpReachabilityTimeouts", () => {
  function expectTimeouts(
    params: Partial<Parameters<typeof resolveCdpReachabilityTimeouts>[0]>,
    httpTimeoutMs: number,
    wsTimeoutMs: number,
  ) {
    expect(
      resolveCdpReachabilityTimeouts({
        profileIsLoopback: false,
        remoteHttpTimeoutMs: 1500,
        remoteHandshakeTimeoutMs: 3000,
        ...params,
      }),
    ).toEqual({ httpTimeoutMs, wsTimeoutMs });
  }

  it("uses loopback defaults when timeout is omitted", () => {
    expectTimeouts({ profileIsLoopback: true }, 300, 600);
  });

  it("clamps loopback websocket timeout range", () => {
    expectTimeouts({ profileIsLoopback: true, timeoutMs: 1 }, 1, 200);
    expectTimeouts({ profileIsLoopback: true, timeoutMs: 5000 }, 5000, 2000);
  });

  it("enforces remote minimums even when caller passes lower timeout", () => {
    expectTimeouts({ timeoutMs: 200 }, 1500, 3000);
  });

  it("uses remote defaults when timeout is omitted", () => {
    expectTimeouts({ remoteHttpTimeoutMs: 1750, remoteHandshakeTimeoutMs: 3250 }, 1750, 3250);
  });

  it("caps remote reachability timeouts to timer-safe values", () => {
    expectTimeouts(
      {
        timeoutMs: Number.MAX_SAFE_INTEGER,
        remoteHttpTimeoutMs: Number.MAX_SAFE_INTEGER,
        remoteHandshakeTimeoutMs: Number.MAX_SAFE_INTEGER,
      },
      MAX_TIMER_TIMEOUT_MS,
      MAX_TIMER_TIMEOUT_MS,
    );
  });
});

function createProfile(overrides: Partial<ResolvedBrowserProfile> = {}): ResolvedBrowserProfile {
  return {
    name: "remote",
    cdpPort: 9223,
    cdpUrl: "http://172.29.128.1:9223",
    cdpHost: "172.29.128.1",
    cdpIsLoopback: false,
    color: "#123456",
    driver: "openclaw",
    attachOnly: false,
    ...overrides,
    headless: overrides.headless ?? false,
  };
}

const localCdp = { cdpUrl: "http://127.0.0.1:9222", cdpHost: "127.0.0.1", cdpIsLoopback: true };
const chromeProfile = createProfile({ ...localCdp, driver: "existing-session" });

describe("CDP reachability policy", () => {
  it("keeps the default remote CDP policy strict without widening browser navigation policy", async () => {
    const policy = {};
    expect(resolveCdpReachabilityPolicy(createProfile(), policy)).toBe(policy);
    expect(policy).toStrictEqual({});
    await expect(
      assertBrowserNavigationAllowed({ url: "http://172.29.128.1/", ssrfPolicy: policy }),
    ).rejects.toThrow(/private\/internal\/special-use ip address/i);
  });

  it("preserves a private-network policy that rejects the selected CDP host", () => {
    const policy = { allowPrivateNetwork: true, allowedHostnames: ["metadata.internal"] };
    expect(resolveCdpReachabilityPolicy(createProfile(), policy)).toBe(policy);
    expect(policy).toEqual({ allowPrivateNetwork: true, allowedHostnames: ["metadata.internal"] });
  });

  it("normalizes the selected CDP host before narrowing wildcard policy", () => {
    expect(
      resolveCdpReachabilityPolicy(
        createProfile({
          cdpUrl: "https://browser.corp.example.:9222",
          cdpHost: "browser.corp.example.",
        }),
        { allowedHostnames: ["*.corp.example"], allowedOrigins: ["https://navigation.example"] },
      ),
    ).toEqual({ allowedHostnames: ["browser.corp.example"] });
  });

  it.each(["*", "*."])("narrows the global %s allowlist to the selected CDP host", (pattern) => {
    expect(resolveCdpReachabilityPolicy(createProfile(), { allowedHostnames: [pattern] })).toEqual({
      allowedHostnames: ["172.29.128.1"],
    });
  });

  it("keeps local managed loopback CDP control outside browser SSRF policy", () => {
    expect(resolveCdpReachabilityPolicy(createProfile(localCdp), {})).toBeUndefined();
  });

  it("narrows configured extension loopback outside navigation allowlist", () => {
    expect(
      resolveCdpReachabilityPolicy(createProfile({ ...localCdp, driver: "extension" }), {
        allowedHostnames: ["*.corp.example"],
      }),
    ).toEqual({ allowedHostnames: ["127.0.0.1"] });
  });

  it.each([
    ["cdpUrl", { cdpUrl: "http://127.0.0.1:9222" }],
    ["--browserUrl", { mcpArgs: ["--browserUrl", "http://127.0.0.1:9222"] }],
    ["--wsEndpoint", { mcpArgs: ["--wsEndpoint=ws://127.0.0.1:9222"] }],
  ])("rejects Chrome MCP explicit %s endpoints under the default policy", (_source, endpoint) => {
    const profile = resolveProfile(
      resolveBrowserConfig({
        profiles: { chrome: { driver: "existing-session", ...endpoint } },
      }),
      "chrome",
    );
    if (!profile) {
      throw new Error("Expected configured Chrome MCP profile");
    }
    expect(() => assertChromeMcpCdpTransportAllowed(profile, {})).toThrow(
      /cannot carry that pinned transport/i,
    );
  });

  it("rejects Chrome MCP explicit CDP URL profiles after default CDP scoping", () => {
    const policy = resolveCdpReachabilityPolicy(chromeProfile, {});
    expect(policy).toEqual({ allowedHostnames: ["127.0.0.1"] });
    expect(() => assertChromeMcpCdpTransportAllowed(chromeProfile, policy)).toThrow(
      /cannot carry that pinned transport/i,
    );
  });

  it("preserves Chrome MCP explicit CDP URL profiles when private CDP endpoints are trusted", () => {
    expect(() =>
      assertChromeMcpCdpTransportAllowed(chromeProfile, { dangerouslyAllowPrivateNetwork: true }),
    ).not.toThrow();
  });

  it("does not let trusted private CDP policy override endpoint allowlists for Chrome MCP", () => {
    expect(() =>
      assertChromeMcpCdpTransportAllowed(chromeProfile, {
        dangerouslyAllowPrivateNetwork: true,
        allowedHostnames: ["127.0.0.1"],
      }),
    ).toThrow(/cannot carry that pinned transport/i);
  });
});

const ownershipParams = {
  ...remoteOwnership,
  cdpUrl: "https://browser.example",
};

describe("CDP ownership fingerprints", () => {
  it("ignores rotated endpoint credentials", async () => {
    async function resolve(value: string) {
      mockVersion(
        `wss://fixture-user:${value}@browser.example/devtools/browser/BROWSER-1?auth=${value}`,
      );
      return resolveCdpTabOwnership({
        ...ownershipParams,
        cdpUrl: `https://fixture-user:${value}@browser.example?auth=${value}`,
      });
    }
    const first = await resolve("fixture-value-a-with-more-than-eighteen-characters");
    const rotated = await resolve("fixture-value-b-with-more-than-eighteen-characters");
    expect(first.status).toBe("durable");
    expect(first).toEqual(rotated);
  });

  it("refuses provider paths that may embed credentials", async () => {
    mockVersion("wss://browser.example/session/fixture-value/devtools/browser/BROWSER-1");
    const unavailable = { status: "non-durable", reason: "browser-identity-unavailable" };
    await expect(resolveCdpTabOwnership(ownershipParams)).resolves.toEqual(unavailable);
    mockVersion("wss://browser.example/devtools/browser/BROWSER-1");
    await expect(
      resolveCdpTabOwnership({
        ...ownershipParams,
        cdpUrl: `https://browser.example/session/${"fixture-path-segment-".repeat(4)}`,
      }),
    ).resolves.toEqual(unavailable);
  });
});
