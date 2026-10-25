import "./agent.snapshot-mocks.test-support.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";
import { expectResponse, expectResponseContaining, runRoute } from "./agent-route.test-support.js";
import {
  captureBrowserOperationTarget,
  resolveOperationTargetOutcome,
} from "./agent.snapshot-target.js";
import { createDashboardRouteContext } from "./dashboard-ownership.test-support.js";
import { createBrowserRouteApp } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const tabLookup = vi.hoisted(() => vi.fn());

const cdp = vi.hoisted(() => ({
  captureScreenshot: vi.fn(),
  getDocumentIdentitiesViaCdp: vi.fn<
    (_opts?: unknown) => Promise<{ mainFrame?: string; frameTree?: string }>
  >(async () => ({ mainFrame: "cdp:test-document", frameTree: "cdp:test-tree" })),
  snapshotAria: vi.fn(async () => ({
    nodes: [{ ref: "1", role: "link", name: "private", depth: 0 }],
  })),
  snapshotRoleViaCdp: vi.fn(async (_opts: unknown) => ({
    snapshot: '- link "private" [ref=e1]',
    refs: { e1: { role: "link", name: "private" } },
  })),
}));

const playwright = vi.hoisted(() => ({
  module: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));

const browserRuntime = vi.hoisted(() => ({
  profiles: new Map<
    string,
    {
      running: { headless?: boolean; headlessSource?: string } | null;
      externalBrowserMode?: { browserWebSocketUrl: string; headless: Promise<boolean | undefined> };
    }
  >(),
}));
const pwMocks = vi.hoisted(() => ({
  screenshot: false,
  connected: false,
  hasCachedPlaywrightBrowserConnection: vi.fn(() => pwMocks.connected),
  takeScreenshotViaPlaywright: vi.fn(async () => ({ buffer: Buffer.from("owned screenshot") })),
}));

const navigation = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async (): Promise<void> => {}),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

// mock-isolation: Supply this suite's synthetic Playwright module without process-wide browser state.
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => (pwMocks.screenshot ? pwMocks : playwright.module)),
  getLoadedPwAiModule: () => (pwMocks.screenshot ? pwMocks : null),
}));

// mock-isolation: Keep managed snapshot capture in the synthetic CDP fixture, not a live browser.
vi.mock("../cdp.js", () => ({
  ...cdp,
}));

vi.mock("../chrome-mcp.js", () => ({
  evaluateChromeMcpScript: vi.fn(),
  navigateChromeMcpPage: vi.fn(),
  takeChromeMcpScreenshot: vi.fn(),
  takeChromeMcpSnapshot: vi.fn(),
}));

// mock-isolation: Observe navigation policy checks without resolving or connecting fixture URLs.
vi.mock("../navigation-guard.js", () => navigation);

const { registerBrowserAgentSnapshotRoutes } = await import("./agent.snapshot.js");

const routeContext = createDashboardRouteContext({
  targetId: "7",
  type: "page",
  title: "Fixture",
  url: "http://127.0.0.1:8080/admin",
  wsUrl: "ws://127.0.0.1/devtools/page/7",
  wsLookup: tabLookup,
});
const target = { cdpUrl: "http://127.0.0.1:18800", targetId: "7" };
const blocked = "browser navigation blocked by policy";
const changed = "Frame changed while its browser snapshot was being captured; retry.";
const roleQuery = { format: "ai", interactive: "true" };
const snapshotState = () => ({
  ...routeContext.state(),
  resolved: {
    ...routeContext.state().resolved,
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
  },
});
const dialogState = (pending: { id: string; message: string }[] = []) => ({
  dialogs: { pending, recent: [] },
});

function snapshotRoute(state = snapshotState()) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, { ...routeContext, state: () => state });
  return getHandlers.get("/snapshot");
}

async function snapshot(query: BrowserRequest["query"], handler = snapshotRoute()) {
  return await runRoute(handler, { query });
}

function createPwModule(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const module = {
    getDocumentIdentitiesViaPlaywright: vi.fn(async () => ({
      mainFrame: "pw:test-document",
      frameTree: "pw:test-tree",
    })),
    getObservedBrowserStateViaPlaywright: vi.fn(async () => dialogState()),
    snapshotRoleViaPlaywright: vi.fn(async () => ({
      snapshot: '- button "Playwright" [ref=e1]',
      refs: { e1: { role: "button", name: "Playwright" } },
    })),
    storeSnapshotRefsViaPlaywright: vi.fn(async () => {}),
    ...overrides,
  };
  playwright.module = module;
  return module;
}

describe("local-managed browser snapshot routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pwMocks.screenshot = false;
    cdp.getDocumentIdentitiesViaCdp.mockReset();
    cdp.snapshotRoleViaCdp.mockReset();
    playwright.module = null;
    navigation.assertBrowserNavigationResultAllowed.mockReset().mockResolvedValue(undefined);
  });

  it("blocks AI CDP role snapshots when the current tab violates browser navigation policy", async () => {
    navigation.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(new Error(blocked));
    const response = await snapshot(roleQuery);

    expectResponse(response, { error: blocked }, 400);
    expect(navigation.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8080/admin",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    });
    expect(cdp.snapshotRoleViaCdp).not.toHaveBeenCalled();
  });

  it("uses CDP first for unscoped managed role snapshots and publishes its refs", async () => {
    const pw = createPwModule();
    const response = await snapshot({
      format: "ai",
      maxChars: 123,
      depth: 2,
      timeoutMs: 3_000_000_000,
    });

    expectResponseContaining(response, { snapshot: expect.stringContaining("private") });
    expect(cdp.snapshotRoleViaCdp).toHaveBeenCalledWith(
      expect.objectContaining({
        recurseIframes: false,
        maxChars: 123,
        timeoutMs: 2_147_483_647,
        options: expect.objectContaining({ maxDepth: 2 }),
      }),
    );
    expect(pw.storeSnapshotRefsViaPlaywright).toHaveBeenCalledWith({
      ...target,
      expectedDocumentIdentity: "pw:test-document",
      refs: { e1: { role: "link", name: "private" } },
      signal: expect.any(AbortSignal),
      deadlineMs: expect.any(Number),
    });
  });

  it.each(["CDP fallback", "ARIA-first"])("uses Playwright for %s", async (mode) => {
    const fallback = mode === "CDP fallback";
    if (fallback) {
      cdp.snapshotRoleViaCdp.mockRejectedValueOnce(new Error("cdp unavailable"));
    }
    createPwModule();
    const response = await snapshot({ ...roleQuery, ...(fallback ? {} : { refs: "aria" }) });
    expectResponseContaining(response, { snapshot: expect.stringContaining("Playwright") });
    expect(cdp.snapshotRoleViaCdp).toHaveBeenCalledTimes(fallback ? 1 : 0);
  });

  it.each([
    ["native AI", true, { format: "ai" }, true],
    ["recursive CDP", false, { format: "ai" }, true],
    ["main-frame ARIA", true, { format: "aria" }, false],
    ["scoped frame with a changing sibling", true, { format: "ai", frame: "#selected" }, false],
    ["changed main-frame loader", false, roleQuery, true],
  ])(
    "validates only captured documents for %s snapshots",
    async (_label, usePlaywright, query, reject) => {
      const identities = vi
        .fn()
        .mockResolvedValueOnce({ mainFrame: "main", frameTree: "before-child-navigation" })
        .mockResolvedValue({
          mainFrame: _label === "changed main-frame loader" ? "changed" : "main",
          frameTree: "after-child-navigation",
        });
      if (usePlaywright) {
        createPwModule({ getDocumentIdentitiesViaPlaywright: identities });
      } else {
        cdp.getDocumentIdentitiesViaCdp.mockImplementation(identities);
      }
      const response = await snapshot(query);
      expect(response.statusCode).toBe(reject ? 500 : 200);
      if (reject) {
        expect(response.body).toEqual({ error: `Error: ${changed}` });
      }
    },
  );

  it.each([
    [
      "the default cap for invalid numeric query tokens",
      { refs: "role", limit: "0x10", maxChars: "1.5", depth: "1e0", timeoutMs: "1000ms" },
      { maxChars: 40_000 },
    ],
    ["an explicit zero cap", { maxChars: "0" }, {}],
  ])("forwards %s to Playwright AI snapshots", async (_name, query, expected) => {
    const { snapshotRoleViaPlaywright } = createPwModule();
    const response = await snapshot(query);

    expect(response.statusCode).toBe(200);
    expect(snapshotRoleViaPlaywright.mock.calls[0]?.[0]).toMatchObject({
      refsMode: "aria",
      timeoutMs: undefined,
      ...expected,
    });
  });

  it("surfaces pending dialog state without reading the blocked page", async () => {
    const { snapshotRoleViaPlaywright } = createPwModule({
      getObservedBrowserStateViaPlaywright: vi.fn(async () =>
        dialogState([{ id: "d1", message: "Continue?" }]),
      ),
    });
    const response = await snapshot({ format: "ai" });

    expectResponseContaining(response, {
      blockedByDialog: true,
      snapshot: "",
      browserState: {
        dialogs: { pending: [expect.objectContaining({ id: "d1", message: "Continue?" })] },
      },
    });
    expect(snapshotRoleViaPlaywright).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "shares delta keys across requests only with stable identity: %s",
    async (stable) => {
      if (!stable) {
        cdp.getDocumentIdentitiesViaCdp.mockResolvedValue({});
      }
      const state = snapshotState();
      const query = { ...roleQuery, urls: "1" };
      const first = await snapshot(query, snapshotRoute(state));
      const second = await snapshot(query, snapshotRoute(state));
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(cdp.snapshotRoleViaCdp.mock.calls.map(([options]) => options)).toMatchObject([
        { urls: true, delta: undefined },
        { urls: true, delta: stable ? { mode: "role", previousKeys: expect.any(Set) } : undefined },
      ]);
      if (!stable) {
        expect(second.body).not.toHaveProperty("newElements");
        expect(second.body).not.toHaveProperty("snapshot", expect.stringContaining("[new]"));
      }
    },
  );
});

async function captureRelay(captureOperationTarget: () => (() => string) | undefined) {
  const relays = new Map([["chrome", { bridge: { captureOperationTarget } }]]);
  const ctx = { state: () => state } as unknown as BrowserRouteContext;
  const state = { extensionRelays: relays, profiles: new Map([["chrome", {}]]) };
  const resolveRelayTarget = await captureBrowserOperationTarget({
    ctx,
    profileName: "chrome",
    targetId: "old-123",
  });
  const outcome = (operationTargetId: string) =>
    resolveOperationTargetOutcome({
      actedOnTargetId: "old-123",
      operationTargetId,
      resolveRelayTarget,
    });
  return { relays, resolveRelayTarget, outcome };
}

describe("captureBrowserOperationTarget", () => {
  it("fails closed when a registered relay cannot capture the acted-on target", async () => {
    const { outcome } = await captureRelay(() => undefined);

    expect(await outcome("unrelated-999")).toBe("old-123");
  });

  it("rejects a replacement relay even when it reports the same profile and target", async () => {
    const { relays, resolveRelayTarget, outcome } = await captureRelay(
      () => () => "replacement-456",
    );

    expect(await outcome("old-123")).toBe("replacement-456");
    relays.set("chrome", {
      bridge: { captureOperationTarget: () => () => "unrelated-999" },
    });
    expect(await resolveRelayTarget?.()).toBeUndefined();
    expect(await outcome("unrelated-999")).toBe("old-123");
  });
});

async function screenshot(body: Record<string, unknown> = {}) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, {
    ...routeContext,
    state: () => ({ ...snapshotState(), profiles: browserRuntime.profiles }),
  } as never);
  return await runRoute(postHandlers.get("/screenshot"), { body: { type: "png", ...body } });
}

describe("browser agent snapshot timeout routing", () => {
  beforeEach(() => {
    pwMocks.screenshot = true;
    cdp.captureScreenshot.mockReset();
    routeContext.forProfile().profile.headless = false;
    browserRuntime.profiles.clear();
    pwMocks.connected = false;
    pwMocks.takeScreenshotViaPlaywright.mockClear();
  });

  it("uses the existing Playwright viewport owner even when the tab has a CDP URL", async () => {
    pwMocks.connected = true;
    cdp.captureScreenshot.mockRejectedValueOnce(new Error("fresh CDP loses the viewport"));
    const response = await screenshot({ timeoutMs: 4321 });
    expect(response.statusCode).toBe(200);
    expect(pwMocks.takeScreenshotViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: "http://127.0.0.1:18800",
        targetId: "7",
        timeoutMs: 4321,
      }),
    );
    expect(cdp.captureScreenshot).not.toHaveBeenCalled();
  });

  it.each([
    { name: "headed launched browser", running: { headless: false, headlessSource: "request" } },
    { name: "observed headed external browser", running: null },
  ])("passes the actual launch mode for $name", async ({ running }) => {
    routeContext.forProfile().profile.headless = true;
    browserRuntime.profiles.set(routeContext.forProfile().profile.name, {
      running,
      ...(running === null
        ? {
            externalBrowserMode: {
              browserWebSocketUrl: "ws://127.0.0.1:18800/devtools/browser/test-browser",
              headless: Promise.resolve(false),
            },
          }
        : {}),
    });
    cdp.captureScreenshot.mockResolvedValueOnce(Buffer.from("png"));
    const response = await screenshot();
    expect(response.statusCode).toBe(200);
    expect(cdp.captureScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ headless: false }),
    );
  });

  it("rejects loose screenshot timeoutMs values before dispatching", async () => {
    const response = await screenshot({ timeoutMs: "1e3" });
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "timeoutMs must be a positive integer." });
    expect(cdp.captureScreenshot).not.toHaveBeenCalled();
  });
});
