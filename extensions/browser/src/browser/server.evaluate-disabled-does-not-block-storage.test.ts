// Browser tests cover server.evaluate disabled does not block storage plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreePort } from "./test-port.js";
import { getBrowserTestFetch } from "./test-support/fetch.js";
import "../test-support/browser-security.mock.js";

let testPort = 0;

const pwMocks = vi.hoisted(() => {
  const closePlaywrightBrowserConnection = vi.fn(async (_opts?: { cdpUrl?: string }) => {});
  return {
    closePlaywrightBrowserConnection,
    cookiesGetViaPlaywright: vi.fn(async () => ({
      cookies: [{ name: "session", value: "abc123" }],
    })),
    storageGetViaPlaywright: vi.fn(async () => ({ values: { token: "value" } })),
    evaluateViaPlaywright: vi.fn(async () => "ok"),
    retirePlaywrightBrowserConnectionExact: vi.fn((opts: { cdpUrl: string }) => ({
      retired: true,
      close: async () => await closePlaywrightBrowserConnection(opts),
    })),
  };
});

const routeCtxMocks = vi.hoisted(() => {
  const profileCtx = {
    profile: { cdpUrl: "http://127.0.0.1:9222" },
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "tab-1",
      url: "https://example.com",
    })),
    stopRunningBrowser: vi.fn(async () => {}),
  };

  return {
    profileCtx,
    createBrowserRouteContext: vi.fn(() => ({
      state: () => ({ resolved: { evaluateEnabled: false } }),
      forProfile: vi.fn(() => profileCtx),
      mapTabError: vi.fn(() => null),
    })),
  };
});

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  const loadConfig = () => ({
    browser: {
      enabled: true,
      evaluateEnabled: false,
      defaultProfile: "openclaw",
      profiles: {
        openclaw: { cdpPort: testPort + 1, color: "#FF4500" },
      },
    },
  });
  return {
    ...actual,
    getRuntimeConfig: loadConfig,
    loadConfig,
    writeConfigFile: vi.fn(async () => {}),
  };
});

vi.mock("./pw-ai-module.js", () => ({
  getLoadedPwAiModule: () => pwMocks,
  getPwAiModule: vi.fn(async () => pwMocks),
}));

vi.mock("./server-context.js", async () => {
  const actual = await vi.importActual<typeof import("./server-context.js")>("./server-context.js");
  return {
    ...actual,
    createBrowserRouteContext: routeCtxMocks.createBrowserRouteContext,
  };
});

const { startBrowserControlServerFromConfig, stopBrowserControlServer } =
  await import("../server.js");

describe("browser control evaluate gating", () => {
  beforeEach(async () => {
    testPort = await getFreePort();
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", String(testPort - 2));
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);

    pwMocks.cookiesGetViaPlaywright.mockClear();
    pwMocks.storageGetViaPlaywright.mockClear();
    pwMocks.evaluateViaPlaywright.mockClear();
    routeCtxMocks.profileCtx.ensureTabAvailable.mockClear();
    routeCtxMocks.profileCtx.stopRunningBrowser.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();

    await stopBrowserControlServer();
  });

  it("blocks act:evaluate but still allows cookies/storage reads", async () => {
    await startBrowserControlServerFromConfig();
    const realFetch = getBrowserTestFetch();

    const base = `http://127.0.0.1:${testPort}`;

    const evalRes = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "evaluate", fn: "() => 1" }),
    }).then((r) => r.json())) as { error?: string };

    expect(evalRes.error).toContain("browser.evaluateEnabled=false");
    expect(pwMocks.evaluateViaPlaywright).not.toHaveBeenCalled();

    const cookiesRes = (await realFetch(`${base}/cookies`).then((r) => r.json())) as {
      ok: boolean;
      cookies?: Array<{ name: string }>;
    };
    expect(cookiesRes.ok).toBe(true);
    expect(cookiesRes.cookies?.[0]?.name).toBe("session");
    expect(pwMocks.cookiesGetViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
    });

    const storageRes = (await realFetch(`${base}/storage/local?key=token`).then((r) =>
      r.json(),
    )) as {
      ok: boolean;
      values?: Record<string, string>;
    };
    expect(storageRes.ok).toBe(true);
    expect(storageRes.values).toEqual({ token: "value" });
    expect(pwMocks.storageGetViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      kind: "local",
      key: "token",
    });
  });
});
