import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../../test-fetch.js";
import "../server-context.chrome-test-harness.js";
import * as cdp from "../cdp.js";
import * as chrome from "../chrome.js";
import { isLocalManagedProfile, resolveBrowserConfig, resolveProfile } from "../config.js";
import { assertBrowserNavigationAllowed } from "../navigation-guard.js";
import * as pwAiModule from "../pw-ai-module.js";
import { withBrowserRequestScope } from "../request-scope.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import { mockLaunchedChrome } from "../server-context.test-harness.js";
import { browserNavigationPolicyForProfile } from "./agent.shared.js";
import { createBrowserRouteDispatcher } from "./dispatcher.js";

const originalFetch = globalThis.fetch;

describe("local preview navigation policy", () => {
  const scope = {
    managedOnly: true as const,
    assertCurrent: async () => {},
    allowLocalLoopback: true,
    assertInvocationCurrent: () => {},
    assertLocalLoopbackCurrent: () => {},
  };
  const loopback = "http://127.0.0.1/";
  const withPreview = <T>(run: () => Promise<T>) => withBrowserRequestScope(scope, run);
  const checkPolicy = (
    policy: ReturnType<typeof browserNavigationPolicyForProfile>,
    url = loopback,
  ) => assertBrowserNavigationAllowed({ url, ...policy });
  const openPreview = (ctx: ReturnType<typeof createBrowserRouteContext>, url: string) =>
    withPreview(() =>
      createBrowserRouteDispatcher(ctx).dispatch({
        method: "POST",
        path: "/tabs/open",
        body: { url },
      }),
    );
  beforeEach(() => {
    let reachable = false;
    vi.mocked(chrome.isChromeReachable)
      .mockReset()
      .mockImplementation(async () => reachable);
    vi.mocked(chrome.isChromeCdpReady)
      .mockReset()
      .mockImplementation(async () => reachable);
    vi.mocked(chrome.isChromeCdpOwnedByPid).mockResolvedValue(true);
    const running = mockLaunchedChrome(vi.mocked(chrome.launchOpenClawChrome), 1234);
    vi.mocked(chrome.launchOpenClawChrome).mockImplementation(async () => {
      reachable = true;
      return running;
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function browserContext(browser?: Parameters<typeof resolveBrowserConfig>[0]) {
    const resolved = resolveBrowserConfig(browser);
    const profile = expectDefined(resolveProfile(resolved, "openclaw"), "managed preview profile");
    const state: BrowserServerState = { port: 0, resolved, profiles: new Map() };
    const ctx = createBrowserRouteContext({ getState: () => state });
    const profileCtx = ctx.forProfile(profile.name);
    return { state, ctx, profileCtx, profile };
  }
  async function navigationPolicy(browser?: Parameters<typeof resolveBrowserConfig>[0]) {
    const { ctx, profileCtx, profile } = browserContext(browser);
    if (isLocalManagedProfile(profile)) {
      vi.mocked(chrome.isChromeReachable).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
      await profileCtx.ensureBrowserAvailable();
    }
    return browserNavigationPolicyForProfile(ctx, profileCtx);
  }
  async function navigate(url = loopback, browser?: Parameters<typeof resolveBrowserConfig>[0]) {
    return checkPolicy(await navigationPolicy(browser), url);
  }
  it.each(["http://127.0.0.1:49187/", "http://localhost:49187/", "http://[::1]:49187/"])(
    "allows an unrestricted local managed preview at %s",
    (url) =>
      withPreview(async () => {
        await expect(navigate(url)).resolves.toBeUndefined();
      }),
  );
  it("rejects a reachable external loopback browser before opening a preview tab", async () => {
    vi.mocked(chrome.isChromeReachable).mockResolvedValue(true);
    vi.mocked(chrome.isChromeCdpReady).mockResolvedValue(true);
    const { ctx, state } = browserContext();
    const response = await openPreview(ctx, "http://127.0.0.1:49187/external-preview");
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ reason: "navigation_blocked" });
    expect(chrome.launchOpenClawChrome).not.toHaveBeenCalled();
    expect(state.profiles.get("openclaw")?.running).toBeNull();
  });
  it.each([
    { url: "about:blank", expectedStatus: 200, expectedCreates: 1 },
    { url: "https://93.184.216.34/", expectedStatus: 200, expectedCreates: 1 },
    { url: "http://127.0.0.1:49187/", expectedStatus: 400, expectedCreates: 0 },
  ])(
    "without Playwright, applies baseline policy to $url",
    async ({ url, expectedStatus, expectedCreates }) => {
      vi.spyOn(pwAiModule, "getPwAiModule").mockResolvedValue(null);
      const create = vi.spyOn(cdp, "createTargetViaCdp").mockResolvedValue({
        targetId: "FALLBACK",
        finalUrl: url,
      });
      globalThis.fetch = withBrowserFetchPreconnect(
        vi.fn(async (input) => {
          const endpoint = String(input);
          if (endpoint.includes("/json/version")) {
            return Response.json({
              webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/browser/OWNED",
            });
          }
          if (endpoint.includes("/json/list")) {
            return Response.json([{ id: "FALLBACK", type: "page", title: "fallback", url }]);
          }
          throw new Error("unexpected fetch: " + endpoint);
        }),
      );
      const { ctx } = browserContext();
      const response = await openPreview(ctx, url);
      expect(response.status).toBe(expectedStatus);
      expect(create).toHaveBeenCalledTimes(expectedCreates);
      if (expectedCreates) {
        expect(response.body).toMatchObject({ targetId: "FALLBACK", url });
      } else {
        expect(response.body).toMatchObject({ reason: "navigation_blocked" });
      }
    },
  );
  it("revokes a captured preview policy when its owned process exits", async () => {
    await withPreview(async () => {
      const { ctx, profileCtx, state } = browserContext();
      await profileCtx.ensureBrowserAvailable();
      const policy = browserNavigationPolicyForProfile(ctx, profileCtx);
      await checkPolicy(policy);
      const running = expectDefined(state.profiles.get("openclaw")?.running, "owned browser");
      running.proc.emit("exit", 0, null);
      await expect(checkPolicy(policy)).rejects.toThrow(
        "current OpenClaw-owned local browser process",
      );
    });
  });
  it("requires a host invocation assertion for an automatic preview grant", async () => {
    await withBrowserRequestScope({ ...scope, assertInvocationCurrent: undefined }, async () => {
      await expect(navigate()).rejects.toThrow(/private|internal|special-use/i);
    });
  });
  it("expires an inherited asynchronous preview grant when the request ends", async () => {
    const resume = createDeferred<void>();
    let lateCheck: Promise<void> | undefined;
    await withPreview(async () => {
      const policy = await navigationPolicy();
      lateCheck = (async () => {
        await resume.promise;
        await expect(checkPolicy(policy)).rejects.toThrow("Browser request has completed");
      })();
    });
    resume.resolve();
    await lateCheck;
  });
  it.each([
    ["explicit empty policy", { ssrfPolicy: {} }],
    ["explicit strict policy", { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } }],
    ["explicit other allowlist", { ssrfPolicy: { allowedHostnames: ["preview.example"] } }],
    ["explicit deny", { ssrfPolicy: { blockedHostnames: ["127.0.0.1"] } }],
    ["remote CDP", { profiles: { openclaw: { cdpUrl: "https://browser.example" } } }],
    ["loopback attach-only", { attachOnly: true }],
    ["explicit browser proxy", { extraArgs: ["--proxy-server=http://proxy.example"] }],
    ["existing session", { profiles: { openclaw: { driver: "existing-session" } } }],
  ] satisfies Array<[string, Parameters<typeof resolveBrowserConfig>[0]]>)(
    "preserves %s",
    (_name, browser) =>
      withPreview(async () => {
        await expect(navigate("http://127.0.0.1:49187/", browser)).rejects.toThrow();
      }),
  );
  it("does not leak the default into another request or the stored policy", async () => {
    const policy = await navigationPolicy();
    await withPreview(() => navigate());
    await expect(checkPolicy(policy)).rejects.toThrow();
    await expect(navigate()).rejects.toThrow();
  });
  it.each([
    "http://10.0.0.1/",
    "http://169.254.169.254/",
    "http://[fd00::1]/",
    "http://127.0.0.2/",
  ])("keeps other protected addresses blocked: %s", (url) =>
    withPreview(async () => {
      await expect(navigate(url)).rejects.toThrow();
    }),
  );
});
