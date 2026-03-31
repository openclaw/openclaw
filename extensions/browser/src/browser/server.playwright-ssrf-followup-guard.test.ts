import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getBrowserTestFetch } from "./test-fetch.js";
import { getFreePort } from "./test-port.js";

let testPort = 0;
let currentTabUrl = "http://127.0.0.1:8080/private";
let currentLivePageUrl = currentTabUrl;
let prevGatewayPort: string | undefined;
let prevGatewayToken: string | undefined;
let prevGatewayPassword: string | undefined;

const pwMocks = vi.hoisted(() => ({
  batchViaPlaywright: vi.fn(async () => ({ results: [] })),
  closePageViaPlaywright: vi.fn(async () => {}),
  cookiesClearViaPlaywright: vi.fn(async () => {}),
  cookiesGetViaPlaywright: vi.fn(async () => ({
    cookies: [{ name: "session", value: "abc123" }],
  })),
  cookiesSetViaPlaywright: vi.fn(async () => {}),
  downloadViaPlaywright: vi.fn(async () => ({
    url: "https://example.com/report.pdf",
    suggestedFilename: "report.pdf",
    path: "/tmp/report.pdf",
  })),
  evaluateViaPlaywright: vi.fn(async () => "ok"),
  getNetworkRequestsViaPlaywright: vi.fn(async () => ({ requests: [] })),
  responseBodyViaPlaywright: vi.fn(async () => ({
    url: "https://example.com/api/data",
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
  })),
  snapshotAiViaPlaywright: vi.fn(async () => ({ snapshot: "ok", refs: {} })),
  snapshotAriaViaPlaywright: vi.fn(async () => ({ nodes: [] })),
  storageGetViaPlaywright: vi.fn(async () => ({ values: { token: "value" } })),
  getPageForTargetId: vi.fn(async () => ({
    url: () => currentLivePageUrl,
  })),
  traceStartViaPlaywright: vi.fn(async () => {}),
  waitForDownloadViaPlaywright: vi.fn(async () => ({
    url: "https://example.com/report.pdf",
    suggestedFilename: "report.pdf",
    path: "/tmp/report.pdf",
  })),
}));

const routeCtxMocks = vi.hoisted(() => {
  const profileCtx = {
    profile: { cdpUrl: "http://127.0.0.1:9222" },
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "tab-1",
      url: currentTabUrl,
    })),
    stopRunningBrowser: vi.fn(async () => {}),
  };

  return {
    profileCtx,
    createBrowserRouteContext: vi.fn(() => ({
      state: () => ({ resolved: { evaluateEnabled: true, ssrfPolicy: undefined } }),
      forProfile: vi.fn(() => profileCtx),
      mapTabError: vi.fn(() => null),
    })),
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      browser: {
        enabled: true,
        evaluateEnabled: true,
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: testPort + 1, color: "#FF4500" },
        },
      },
    }),
    writeConfigFile: vi.fn(async () => {}),
  };
});

vi.mock("./pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => pwMocks),
}));

vi.mock("./server-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-context.js")>();
  return {
    ...actual,
    createBrowserRouteContext: routeCtxMocks.createBrowserRouteContext,
  };
});

let startBrowserControlServerFromConfig: typeof import("./server.js").startBrowserControlServerFromConfig;
let stopBrowserControlServer: typeof import("./server.js").stopBrowserControlServer;

describe("browser control Playwright follow-up SSRF guard", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ startBrowserControlServerFromConfig, stopBrowserControlServer } =
      await import("./server.js"));
  });

  beforeEach(async () => {
    testPort = await getFreePort();
    currentTabUrl = "http://127.0.0.1:8080/private";
    currentLivePageUrl = currentTabUrl;
    prevGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
    process.env.OPENCLAW_GATEWAY_PORT = String(testPort - 2);
    prevGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    prevGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;

    pwMocks.closePageViaPlaywright.mockClear();
    pwMocks.cookiesClearViaPlaywright.mockClear();
    pwMocks.batchViaPlaywright.mockClear();
    pwMocks.cookiesGetViaPlaywright.mockClear();
    pwMocks.cookiesSetViaPlaywright.mockClear();
    pwMocks.downloadViaPlaywright.mockClear();
    pwMocks.evaluateViaPlaywright.mockClear();
    pwMocks.getNetworkRequestsViaPlaywright.mockClear();
    pwMocks.responseBodyViaPlaywright.mockClear();
    pwMocks.snapshotAiViaPlaywright.mockClear();
    pwMocks.snapshotAriaViaPlaywright.mockClear();
    pwMocks.storageGetViaPlaywright.mockClear();
    pwMocks.getPageForTargetId.mockClear();
    pwMocks.traceStartViaPlaywright.mockClear();
    pwMocks.waitForDownloadViaPlaywright.mockClear();
    routeCtxMocks.profileCtx.ensureTabAvailable.mockClear();
    routeCtxMocks.profileCtx.stopRunningBrowser.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevGatewayPort === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PORT;
    } else {
      process.env.OPENCLAW_GATEWAY_PORT = prevGatewayPort;
    }
    if (prevGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevGatewayToken;
    }
    if (prevGatewayPassword === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    } else {
      process.env.OPENCLAW_GATEWAY_PASSWORD = prevGatewayPassword;
    }

    await stopBrowserControlServer();
  });

  it("blocks readout and download routes on forbidden Playwright targets", async () => {
    await startBrowserControlServerFromConfig();
    const realFetch = getBrowserTestFetch();
    const base = `http://127.0.0.1:${testPort}`;

    const evalRes = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "evaluate", fn: "() => 1" }),
    }).then((r) => r.json())) as { error?: string };
    expect(evalRes.error).toContain("Blocked");

    const batchRes = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "batch", actions: [{ kind: "evaluate", fn: "() => 1" }] }),
    }).then((r) => r.json())) as { error?: string };
    expect(batchRes.error).toContain("Blocked");

    const cookiesRes = (await realFetch(`${base}/cookies`).then((r) => r.json())) as {
      error?: string;
    };
    expect(cookiesRes.error).toContain("Blocked");

    const cookiesSetRes = (await realFetch(`${base}/cookies/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cookie: { name: "session", value: "abc123", url: "https://example.com" },
      }),
    }).then((r) => r.json())) as { error?: string };
    expect(cookiesSetRes.error).toContain("Blocked");

    const cookiesClearRes = (await realFetch(`${base}/cookies/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).then((r) => r.json())) as { error?: string };
    expect(cookiesClearRes.error).toContain("Blocked");

    const storageRes = (await realFetch(`${base}/storage/local?key=token`).then((r) =>
      r.json(),
    )) as { error?: string };
    expect(storageRes.error).toContain("Blocked");

    const responseRes = (await realFetch(`${base}/response/body`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "**/api/data" }),
    }).then((r) => r.json())) as { error?: string };
    expect(responseRes.error).toContain("Blocked");

    const snapshotAiRes = (await realFetch(`${base}/snapshot?format=ai`).then((r) => r.json())) as {
      error?: string;
    };
    expect(snapshotAiRes.error).toContain("Blocked");

    const snapshotAriaRes = (await realFetch(`${base}/snapshot?format=aria`).then((r) =>
      r.json(),
    )) as { error?: string };
    expect(snapshotAriaRes.error).toContain("Blocked");

    const requestsRes = (await realFetch(`${base}/requests`).then((r) => r.json())) as {
      error?: string;
    };
    expect(requestsRes.error).toContain("Blocked");

    const waitDownloadRes = (await realFetch(`${base}/wait/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "report.pdf" }),
    }).then((r) => r.json())) as { error?: string };
    expect(waitDownloadRes.error).toContain("Blocked");

    const downloadRes = (await realFetch(`${base}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "e1", path: "report.pdf" }),
    }).then((r) => r.json())) as { error?: string };
    expect(downloadRes.error).toContain("Blocked");

    expect(pwMocks.closePageViaPlaywright).toHaveBeenCalledTimes(12);
    expect(pwMocks.batchViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.cookiesClearViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.cookiesGetViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.cookiesSetViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.downloadViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.evaluateViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.getNetworkRequestsViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.storageGetViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.responseBodyViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.snapshotAiViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.snapshotAriaViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.waitForDownloadViaPlaywright).not.toHaveBeenCalled();
  });

  it("still allows privileged follow-up actions on public Playwright targets", async () => {
    currentTabUrl = "https://example.com";
    currentLivePageUrl = currentTabUrl;
    await startBrowserControlServerFromConfig();
    const realFetch = getBrowserTestFetch();
    const base = `http://127.0.0.1:${testPort}`;

    const evalRes = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "evaluate", fn: "() => 1" }),
    }).then((r) => r.json())) as { ok?: boolean; result?: string };

    const batchRes = (await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "batch", actions: [{ kind: "evaluate", fn: "() => 1" }] }),
    }).then((r) => r.json())) as { ok?: boolean; results?: Array<{ ok: boolean }> };

    const cookiesRes = (await realFetch(`${base}/cookies`).then((r) => r.json())) as {
      ok?: boolean;
      cookies?: Array<{ name: string }>;
    };

    const cookiesSetRes = (await realFetch(`${base}/cookies/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cookie: { name: "session", value: "abc123", url: "https://example.com" },
      }),
    }).then((r) => r.json())) as { ok?: boolean };

    const cookiesClearRes = (await realFetch(`${base}/cookies/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).then((r) => r.json())) as { ok?: boolean };

    const snapshotAiRes = (await realFetch(`${base}/snapshot?format=ai`).then((r) => r.json())) as {
      ok?: boolean;
      format?: string;
    };

    const requestsRes = (await realFetch(`${base}/requests`).then((r) => r.json())) as {
      ok?: boolean;
    };

    expect(evalRes.ok).toBe(true);
    expect(evalRes.result).toBe("ok");
    expect(batchRes.ok).toBe(true);
    expect(batchRes.results).toEqual([]);
    expect(cookiesRes.ok).toBe(true);
    expect(cookiesRes.cookies?.[0]?.name).toBe("session");
    expect(cookiesSetRes.ok).toBe(true);
    expect(cookiesClearRes.ok).toBe(true);
    expect(requestsRes.ok).toBe(true);
    expect(snapshotAiRes.ok).toBe(true);
    expect(snapshotAiRes.format).toBe("ai");
    expect(pwMocks.closePageViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.batchViaPlaywright).toHaveBeenCalledTimes(1);
    expect(pwMocks.cookiesClearViaPlaywright).toHaveBeenCalledTimes(1);
    expect(pwMocks.cookiesGetViaPlaywright).toHaveBeenCalledTimes(1);
    expect(pwMocks.cookiesSetViaPlaywright).toHaveBeenCalledTimes(1);
    expect(pwMocks.evaluateViaPlaywright).toHaveBeenCalledTimes(1);
    expect(pwMocks.getNetworkRequestsViaPlaywright).toHaveBeenCalledTimes(1);
    expect(pwMocks.snapshotAiViaPlaywright).toHaveBeenCalledTimes(1);
  });

  it("uses the live Playwright page URL for follow-up guards", async () => {
    currentTabUrl = "https://example.com/public";
    currentLivePageUrl = "http://127.0.0.1:8080/private";
    await startBrowserControlServerFromConfig();
    const realFetch = getBrowserTestFetch();
    const base = `http://127.0.0.1:${testPort}`;

    const cookiesRes = (await realFetch(`${base}/cookies`).then((r) => r.json())) as {
      error?: string;
    };

    expect(cookiesRes.error).toContain("Blocked");
    expect(pwMocks.getPageForTargetId).toHaveBeenCalledTimes(1);
    expect(pwMocks.closePageViaPlaywright).toHaveBeenCalledTimes(1);
    expect(pwMocks.cookiesGetViaPlaywright).not.toHaveBeenCalled();
  });

  it("blocks follow-up actions when live target URL resolution fails", async () => {
    currentTabUrl = "https://example.com/public";
    pwMocks.getPageForTargetId.mockRejectedValueOnce(new Error("session dropped"));
    await startBrowserControlServerFromConfig();
    const realFetch = getBrowserTestFetch();
    const base = `http://127.0.0.1:${testPort}`;

    const cookiesRes = (await realFetch(`${base}/cookies`).then((r) => r.json())) as {
      error?: string;
    };

    expect(cookiesRes.error).toContain("Blocked");
    expect(pwMocks.getPageForTargetId).toHaveBeenCalledTimes(1);
    expect(pwMocks.closePageViaPlaywright).toHaveBeenCalledTimes(1);
    expect(pwMocks.cookiesGetViaPlaywright).not.toHaveBeenCalled();
  });

  it("blocks follow-up actions when the live target URL is blank", async () => {
    currentTabUrl = "https://example.com/public";
    pwMocks.getPageForTargetId.mockResolvedValueOnce({
      url: () => "   ",
    });
    await startBrowserControlServerFromConfig();
    const realFetch = getBrowserTestFetch();
    const base = `http://127.0.0.1:${testPort}`;

    const cookiesRes = (await realFetch(`${base}/cookies`).then((r) => r.json())) as {
      error?: string;
    };

    expect(cookiesRes.error).toContain("Blocked");
    expect(pwMocks.getPageForTargetId).toHaveBeenCalledTimes(1);
    expect(pwMocks.closePageViaPlaywright).toHaveBeenCalledTimes(1);
    expect(pwMocks.cookiesGetViaPlaywright).not.toHaveBeenCalled();
  });
});
