import "./agent.snapshot-mocks.test-support.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";
import { expectResponse, expectResponseContaining, runRoute } from "./agent-route.test-support.js";
import {
  captureBrowserOperationTarget,
  resolveOperationTargetOutcome,
} from "./agent.snapshot-target.js";
import { createBrowserRouteApp } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const tabLookup = vi.hoisted(() => vi.fn());

const routeState = vi.hoisted(() => ({
  profileCtx: {
    profile: {
      driver: "openclaw" as const,
      name: "openclaw",
      cdpUrl: "http://127.0.0.1:18800",
      cdpIsLoopback: true,
    },
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "7",
      url: "http://127.0.0.1:8080/admin",
      wsUrl: "ws://127.0.0.1/devtools/page/7",
      wsLookup: tabLookup,
    })),
  },
}));

const cdp = vi.hoisted(() => ({
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

const navigation = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async (): Promise<void> => {}),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

// mock-isolation: Supply this suite's synthetic Playwright module without process-wide browser state.
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => playwright.module),
  getLoadedPwAiModule: () => null,
}));

// mock-isolation: Keep managed snapshot capture in the synthetic CDP fixture, not a live browser.
vi.mock("../cdp.js", () => ({
  captureScreenshot: vi.fn(),
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

vi.mock("./agent.shared.js", () => ({
  browserNavigationPolicyForProfile: vi.fn(() => ({
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
  })),
  handleRouteError: vi.fn(
    (res: { status: (code: number) => unknown; json: (body: unknown) => void }, err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400);
      res.json({ error: message });
    },
  ),
  readBody: vi.fn((req: BrowserRequest) => req.body ?? {}),
  requirePwAi: vi.fn(async () => null),
  resolveProfileContext: vi.fn(() => routeState.profileCtx),
  withPlaywrightRouteContext: vi.fn(),
  withRouteTabContext: vi.fn(),
}));

const { registerBrowserAgentSnapshotRoutes } = await import("./agent.snapshot.js");

const target = { cdpUrl: "http://127.0.0.1:18800", targetId: "7" };
const blocked = "browser navigation blocked by policy";
const changed = "Frame changed while its browser snapshot was being captured; retry.";
const roleQuery = { format: "ai", interactive: "true" };
const snapshotState = () => ({
  resolved: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } },
});
const dialogState = (pending: { id: string; message: string }[] = []) => ({
  dialogs: { pending, recent: [] },
});

function snapshotRoute(state = snapshotState()) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, { state: () => state } as never);
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
    expect(pw.snapshotRoleViaPlaywright).not.toHaveBeenCalled();
    expect(cdp.snapshotRoleViaCdp).toHaveBeenCalledWith(
      expect.objectContaining({
        recurseIframes: false,
        maxChars: 123,
        timeoutMs: 2_147_483_647,
        options: { interactive: undefined, compact: undefined, maxDepth: 2 },
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
    const pw = createPwModule();
    const response = await snapshot({ ...roleQuery, ...(fallback ? {} : { refs: "aria" }) });
    expectResponseContaining(response, { snapshot: expect.stringContaining("Playwright") });
    expect(pw.snapshotRoleViaPlaywright).toHaveBeenCalledTimes(1);
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
      expect(response.statusCode).toBe(reject ? 400 : 200);
      if (reject) {
        expect(response.body).toEqual({ error: changed });
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
    expect(snapshotRoleViaPlaywright).toHaveBeenCalledWith({
      ...target,
      refsMode: "aria",
      signal: expect.any(AbortSignal),
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      timeoutMs: undefined,
      urls: undefined,
      delta: undefined,
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

  it("disables deltas when no stable document identity is available", async () => {
    cdp.getDocumentIdentitiesViaCdp.mockResolvedValue({});
    const handler = snapshotRoute();
    await snapshot(roleQuery, handler);
    const second = await snapshot(roleQuery, handler);
    expect(cdp.snapshotRoleViaCdp.mock.calls.map(([options]) => options)).toMatchObject([
      { delta: undefined },
      { delta: undefined },
    ]);
    expect(second.body).not.toHaveProperty("newElements");
    expect(second.body).not.toHaveProperty("snapshot", expect.stringContaining("[new]"));
  });

  it("reuses same-document delta keys across request contexts in one browser runtime", async () => {
    const state = snapshotState();
    const query = { ...roleQuery, urls: "1" };
    const first = await snapshot(query, snapshotRoute(state));
    const second = await snapshot(query, snapshotRoute(state));
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(cdp.getDocumentIdentitiesViaCdp).toHaveBeenCalledWith(
      expect.objectContaining({ wsUrl: "ws://127.0.0.1/devtools/page/7", lookup: tabLookup }),
    );
    expect(cdp.snapshotRoleViaCdp.mock.calls[1]?.[0]).toMatchObject({
      urls: true,
      delta: { mode: "role", previousKeys: expect.any(Set) },
    });
  });
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
    const { resolveRelayTarget, outcome } = await captureRelay(() => undefined);

    expect(typeof resolveRelayTarget).toBe("function");
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
