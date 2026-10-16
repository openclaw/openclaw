import "./agent.snapshot-mocks.test-support.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";
import { expectResponse, expectResponseContaining, runRoute } from "./agent-route.test-support.js";
import {
  captureBrowserOperationTarget,
  resolveOperationTargetOutcome,
} from "./agent.snapshot-target.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
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
    stats: { lines: 1, chars: 25, refs: 1, interactive: 1 },
  })),
}));

const playwright = vi.hoisted(() => ({
  module: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));

const navigation = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async (): Promise<void> => {
    throw new Error("browser navigation blocked by policy");
  }),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => playwright.module),
  getLoadedPwAiModule: () => null,
}));

vi.mock("../cdp.js", () => ({
  captureScreenshot: vi.fn(),
  getDocumentIdentitiesViaCdp: cdp.getDocumentIdentitiesViaCdp,
  snapshotAria: cdp.snapshotAria,
  snapshotRoleViaCdp: cdp.snapshotRoleViaCdp,
}));

vi.mock("../chrome-mcp.js", () => ({
  evaluateChromeMcpScript: vi.fn(),
  navigateChromeMcpPage: vi.fn(),
  takeChromeMcpScreenshot: vi.fn(),
  takeChromeMcpSnapshot: vi.fn(),
}));

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

function snapshotState() {
  return {
    resolved: {
      actionTimeoutMs: 60_000,
      extraArgs: [],
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    },
  };
}

function snapshotRoute(state = snapshotState()) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, { state: () => state } as never);
  const handler = getHandlers.get("/snapshot");
  expect(handler).toBeTypeOf("function");
  return handler;
}

async function snapshot(query: BrowserRequest["query"]) {
  return await runRoute(snapshotRoute(), { query });
}

function createPwModule(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    getDocumentIdentitiesViaPlaywright: vi.fn(async () => ({
      mainFrame: "pw:test-document",
      frameTree: "pw:test-tree",
    })),
    getObservedBrowserStateViaPlaywright: vi.fn(async () => ({
      dialogs: { pending: [], recent: [] },
    })),
    snapshotRoleViaPlaywright: vi.fn(async () => ({
      snapshot: '- button "Playwright" [ref=e1]',
      refs: { e1: { role: "button", name: "Playwright" } },
      stats: { lines: 1, chars: 32, refs: 1, interactive: 1 },
    })),
    storeSnapshotRefsViaPlaywright: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("local-managed browser snapshot routes", () => {
  beforeEach(() => {
    routeState.profileCtx.ensureTabAvailable.mockClear();
    cdp.getDocumentIdentitiesViaCdp.mockReset();
    cdp.snapshotAria.mockClear();
    cdp.snapshotRoleViaCdp.mockReset();
    playwright.module = null;
    tabLookup.mockClear();
    navigation.assertBrowserNavigationResultAllowed.mockReset().mockResolvedValue(undefined);
    navigation.withBrowserNavigationPolicy.mockClear();
  });

  it("blocks AI CDP role snapshots when the current tab violates browser navigation policy", async () => {
    navigation.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      new Error("browser navigation blocked by policy"),
    );
    const response = await snapshot({ format: "ai", interactive: "true" });

    expectResponse(response, { error: "browser navigation blocked by policy" }, 400);
    expect(navigation.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8080/admin",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    });
    expect(cdp.snapshotRoleViaCdp).not.toHaveBeenCalled();
  });

  it("uses CDP first for unscoped managed role snapshots and publishes its refs", async () => {
    const pw = createPwModule();
    playwright.module = pw;
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
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "7",
      expectedDocumentIdentity: "pw:test-document",
      refs: { e1: { role: "link", name: "private" } },
      signal: expect.any(AbortSignal),
      deadlineMs: expect.any(Number),
    });
  });

  it("falls back to Playwright once when the CDP-first snapshot fails early", async () => {
    cdp.snapshotRoleViaCdp.mockRejectedValueOnce(new Error("cdp unavailable"));
    const pw = createPwModule();
    playwright.module = pw;
    const response = await snapshot({ format: "ai", interactive: "true" });

    expectResponseContaining(response, { snapshot: expect.stringContaining("Playwright") });
    expect(cdp.snapshotRoleViaCdp).toHaveBeenCalledTimes(1);
    expect(pw.snapshotRoleViaPlaywright).toHaveBeenCalledTimes(1);
  });

  it("keeps aria refs on Playwright-first role snapshots", async () => {
    const pw = createPwModule();
    playwright.module = pw;
    const response = await snapshot({ format: "ai", interactive: "true", refs: "aria" });

    expectResponseContaining(response, { snapshot: expect.stringContaining("Playwright") });
    expect(pw.snapshotRoleViaPlaywright).toHaveBeenCalledTimes(1);
    expect(cdp.snapshotRoleViaCdp).not.toHaveBeenCalled();
  });

  it.each([
    ["native AI", true, { format: "ai" }, true],
    ["recursive CDP", false, { format: "ai" }, true],
    ["main-frame ARIA", true, { format: "aria" }, false],
    ["scoped frame with a changing sibling", true, { format: "ai", frame: "#selected" }, false],
  ])(
    "validates only captured documents for %s snapshots",
    async (_label, usePlaywright, query, reject) => {
      const identities = vi
        .fn()
        .mockResolvedValueOnce({ mainFrame: "main", frameTree: "before-child-navigation" })
        .mockResolvedValue({ mainFrame: "main", frameTree: "after-child-navigation" });
      if (usePlaywright) {
        playwright.module = createPwModule({ getDocumentIdentitiesViaPlaywright: identities });
      } else {
        cdp.getDocumentIdentitiesViaCdp.mockImplementation(identities);
      }
      const response = await snapshot(query);
      expect(response.statusCode).toBe(reject ? 400 : 200);
      if (reject) {
        expect(response.body).toEqual({
          error: "Frame changed while its browser snapshot was being captured; retry.",
        });
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
    const snapshotRoleViaPlaywright = vi.fn(async () => ({ snapshot: "Playwright" }));
    playwright.module = createPwModule({ snapshotRoleViaPlaywright });
    const response = await snapshot(query);

    expect(response.statusCode).toBe(200);
    expect(snapshotRoleViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "7",
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
    const snapshotRoleViaPlaywright = vi.fn(async () => ({ snapshot: "Playwright" }));
    playwright.module = createPwModule({
      getObservedBrowserStateViaPlaywright: vi.fn(async () => ({
        dialogs: {
          pending: [
            {
              id: "d1",
              type: "confirm",
              message: "Continue?",
              openedAt: "2026-05-17T12:00:00.000Z",
            },
          ],
          recent: [],
        },
      })),
      snapshotRoleViaPlaywright,
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

  it("rejects a snapshot when the main-frame loader changes during capture", async () => {
    cdp.getDocumentIdentitiesViaCdp
      .mockResolvedValueOnce({ mainFrame: "cdp:before", frameTree: "cdp:tree-before" })
      .mockResolvedValueOnce({ mainFrame: "cdp:after", frameTree: "cdp:tree-after" });
    const response = await snapshot({ format: "ai", interactive: "true" });

    expectResponse(
      response,
      { error: "Frame changed while its browser snapshot was being captured; retry." },
      400,
    );
  });

  it("disables deltas when no stable document identity is available", async () => {
    cdp.getDocumentIdentitiesViaCdp.mockResolvedValue({});
    const handler = snapshotRoute();
    const first = createBrowserRouteResponse();
    const second = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai", interactive: "true" } }, first.res);
    await handler?.({ params: {}, query: { format: "ai", interactive: "true" } }, second.res);

    const calls = cdp.snapshotRoleViaCdp.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toMatchObject({ delta: undefined });
    expect(calls[1]?.[0]).toMatchObject({ delta: undefined });
    expect(second.body).not.toHaveProperty("newElements");
    expect(second.body).not.toHaveProperty("snapshot", expect.stringContaining("[new]"));
  });

  it("reuses same-document delta keys across request contexts in one browser runtime", async () => {
    const state = snapshotState();
    const firstHandler = snapshotRoute(state);
    const secondHandler = snapshotRoute(state);
    const first = createBrowserRouteResponse();
    const second = createBrowserRouteResponse();
    const request = { params: {}, query: { format: "ai", interactive: "true", urls: "1" } };

    await firstHandler?.(request, first.res);
    await secondHandler?.(request, second.res);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(cdp.getDocumentIdentitiesViaCdp).toHaveBeenCalledWith(
      expect.objectContaining({ wsUrl: "ws://127.0.0.1/devtools/page/7", lookup: tabLookup }),
    );
    expect(cdp.snapshotRoleViaCdp.mock.calls[1]?.[0]).toMatchObject({
      urls: true,
      delta: { mode: "role", previousKeys: expect.any(Set) },
    });
  });
});

async function captureRelay(bridge: { captureOperationTarget: () => (() => string) | undefined }) {
  const relays = new Map([["chrome", { bridge }]]);
  const ctx = { state: () => state } as unknown as BrowserRouteContext;
  const state = { extensionRelays: relays, profiles: new Map([["chrome", {}]]) };
  const resolveRelayTarget = await captureBrowserOperationTarget({
    ctx,
    profileName: "chrome",
    targetId: "old-123",
  });
  return { relays, resolveRelayTarget };
}

describe("captureBrowserOperationTarget", () => {
  it("fails closed when a registered relay cannot capture the acted-on target", async () => {
    const { resolveRelayTarget } = await captureRelay({ captureOperationTarget: () => undefined });

    expect(typeof resolveRelayTarget).toBe("function");
    expect(
      await resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "unrelated-999",
        resolveRelayTarget,
      }),
    ).toBe("old-123");
  });

  it("rejects a replacement relay even when it reports the same profile and target", async () => {
    const { relays, resolveRelayTarget } = await captureRelay({
      captureOperationTarget: () => () => "replacement-456",
    });

    expect(
      await resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "old-123",
        resolveRelayTarget,
      }),
    ).toBe("replacement-456");
    relays.set("chrome", {
      bridge: { captureOperationTarget: () => () => "unrelated-999" },
    });
    expect(await resolveRelayTarget?.()).toBeUndefined();
    expect(
      await resolveOperationTargetOutcome({
        actedOnTargetId: "old-123",
        operationTargetId: "unrelated-999",
        resolveRelayTarget,
      }),
    ).toBe("old-123");
  });
});
