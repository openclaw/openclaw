// Browser tests cover agent.snapshot.timeout plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

type SnapshotAriaViaPlaywright = (opts: unknown) => Promise<{ nodes: never[] }>;
type SnapshotAriaViaCdp = (opts: { signal?: AbortSignal }) => Promise<{ nodes: never[] }>;
type StoreAriaSnapshotRefsViaPlaywright = (opts: { signal?: AbortSignal }) => Promise<void>;
type SnapshotRoleViaPlaywright = (opts: { signal?: AbortSignal }) => Promise<{
  snapshot: string;
  refs: Record<string, never>;
  stats: { lines: number; chars: number; refs: number; interactive: number };
}>;

const cdpMocks = vi.hoisted(() => ({
  captureScreenshot: vi.fn(),
  getMainFrameDocumentIdentityViaCdp: vi.fn(async () => "cdp:test-document"),
  snapshotAria: vi.fn<SnapshotAriaViaCdp>(async () => ({ nodes: [] })),
  snapshotRoleViaCdp: vi.fn(async () => ({
    snapshot: "button Continue",
    refs: {},
    stats: { lines: 1, chars: 15, refs: 0, interactive: 0 },
  })),
}));

const pwMocks = vi.hoisted(() => ({
  getModule: vi.fn(
    async () =>
      null as null | {
        getObservedBrowserStateViaPlaywright: (opts: {
          signal?: AbortSignal;
        }) => Promise<undefined>;
        getMainFrameDocumentIdentityViaPlaywright?: (opts: {
          signal?: AbortSignal;
        }) => Promise<string | undefined>;
        snapshotAiViaPlaywright?: SnapshotRoleViaPlaywright;
        snapshotAriaViaPlaywright?: SnapshotAriaViaPlaywright;
        snapshotRoleViaPlaywright?: SnapshotRoleViaPlaywright;
        storeAriaSnapshotRefsViaPlaywright?: StoreAriaSnapshotRefsViaPlaywright;
      },
  ),
  getObservedBrowserStateViaPlaywright: vi.fn(async () => undefined),
  getMainFrameDocumentIdentityViaPlaywright: vi.fn(async () => "pw:test-document"),
  requireModule: vi.fn(
    async () => null as null | { snapshotAriaViaPlaywright: SnapshotAriaViaPlaywright },
  ),
  snapshotAriaViaPlaywright: vi.fn(async () => ({ nodes: [] })),
  snapshotRoleViaPlaywright: vi.fn<SnapshotRoleViaPlaywright>(async () => ({
    snapshot: "button Continue",
    refs: {},
    stats: { lines: 1, chars: 15, refs: 0, interactive: 0 },
  })),
  storeAriaSnapshotRefsViaPlaywright: vi.fn<StoreAriaSnapshotRefsViaPlaywright>(async () => {}),
}));

const profileContext = vi.hoisted(() => ({
  profile: {
    name: "openclaw",
    driver: "openclaw" as const,
    cdpPort: 18_800,
    cdpUrl: "http://127.0.0.1:18800",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    color: "#FF4500",
    headless: false,
    attachOnly: false,
  },
  ensureTabAvailable: vi.fn(
    async (): Promise<{ targetId: string; url: string; wsUrl: string | undefined }> => ({
      targetId: "tab-1",
      url: "https://example.com",
      wsUrl: "ws://127.0.0.1:18800/devtools/page/tab-1",
    }),
  ),
}));

vi.mock("../cdp.js", () => ({
  captureScreenshot: cdpMocks.captureScreenshot,
  getMainFrameDocumentIdentityViaCdp: cdpMocks.getMainFrameDocumentIdentityViaCdp,
  snapshotAria: cdpMocks.snapshotAria,
  snapshotRoleViaCdp: cdpMocks.snapshotRoleViaCdp,
}));

vi.mock("../chrome-mcp.js", () => ({
  evaluateChromeMcpScript: vi.fn(),
  navigateChromeMcpPage: vi.fn(),
  takeChromeMcpScreenshot: vi.fn(),
  takeChromeMcpSnapshot: vi.fn(),
}));

vi.mock("../navigation-guard.js", () => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  withBrowserNavigationPolicy: vi.fn(() => ({})),
}));

vi.mock("../screenshot.js", () => ({
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 128,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 64,
  normalizeBrowserScreenshot: vi.fn(async (buffer: Buffer) => ({
    buffer,
    contentType: "image/png",
  })),
}));

vi.mock("../../media/store.js", () => ({
  ensureMediaDir: vi.fn(async () => {}),
  saveMediaBuffer: vi.fn(async () => ({ path: "/tmp/fake.png" })),
}));

vi.mock("./agent.shared.js", () => ({
  browserNavigationPolicyForProfile: vi.fn(() => ({})),
  getPwAiModule: pwMocks.getModule,
  handleRouteError: vi.fn((_ctx, _res, err) => {
    throw err;
  }),
  readBody: vi.fn((req: { body?: unknown }) => req.body ?? {}),
  requirePwAi: pwMocks.requireModule,
  resolveProfileContext: vi.fn(() => profileContext),
  withPlaywrightRouteContext: vi.fn(),
  withRouteTabContext: vi.fn(
    async (params: {
      run: (ctx: {
        profileCtx: typeof profileContext;
        tab: { targetId: string; url: string; wsUrl: string };
        cdpUrl: string;
      }) => Promise<void>;
    }) =>
      await params.run({
        profileCtx: profileContext,
        tab: {
          targetId: "tab-1",
          url: "https://example.com",
          wsUrl: "ws://127.0.0.1:18800/devtools/page/tab-1",
        },
        cdpUrl: "http://127.0.0.1:18800",
      }),
  ),
}));

const { registerBrowserAgentSnapshotRoutes } = await import("./agent.snapshot.js");

function getSnapshotHandler() {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, {
    state: () => ({ resolved: { extraArgs: [] } }),
  } as never);
  const handler = getHandlers.get("/snapshot");
  expect(handler).toBeTypeOf("function");
  return handler;
}

function getScreenshotHandler() {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, {
    state: () => ({ resolved: { extraArgs: [] } }),
  } as never);
  const handler = postHandlers.get("/screenshot");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("browser agent snapshot timeout routing", () => {
  beforeEach(() => {
    cdpMocks.captureScreenshot.mockClear();
    cdpMocks.snapshotAria.mockClear();
    cdpMocks.snapshotRoleViaCdp.mockClear();
    profileContext.ensureTabAvailable.mockClear();
    pwMocks.getModule.mockReset();
    pwMocks.getModule.mockResolvedValue(null);
    pwMocks.getMainFrameDocumentIdentityViaPlaywright.mockReset();
    pwMocks.getMainFrameDocumentIdentityViaPlaywright.mockResolvedValue("pw:test-document");
    pwMocks.requireModule.mockReset();
    pwMocks.requireModule.mockResolvedValue(null);
    pwMocks.snapshotAriaViaPlaywright.mockClear();
    pwMocks.snapshotRoleViaPlaywright.mockReset();
    pwMocks.snapshotRoleViaPlaywright.mockResolvedValue({
      snapshot: "button Continue",
      refs: {},
      stats: { lines: 1, chars: 15, refs: 0, interactive: 0 },
    });
    pwMocks.storeAriaSnapshotRefsViaPlaywright.mockReset();
    pwMocks.storeAriaSnapshotRefsViaPlaywright.mockResolvedValue(undefined);
  });

  it("passes timeoutMs to direct CDP aria snapshots", async () => {
    const handler = getSnapshotHandler();
    const response = createBrowserRouteResponse();
    const controller = new AbortController();

    await handler?.(
      {
        params: {},
        query: { format: "aria", timeoutMs: "4321" },
        signal: controller.signal,
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(cdpMocks.snapshotAria).toHaveBeenCalledWith(
      expect.objectContaining({
        wsUrl: "ws://127.0.0.1:18800/devtools/page/tab-1",
        targetId: "tab-1",
        signal: expect.any(AbortSignal),
      }),
    );
    const snapshotSignal = (
      cdpMocks.snapshotAria.mock.calls[0]?.[0] as { signal?: AbortSignal } | undefined
    )?.signal;
    const snapshotTimeoutMs = (
      cdpMocks.snapshotAria.mock.calls[0]?.[0] as { timeoutMs?: number } | undefined
    )?.timeoutMs;
    expect(snapshotTimeoutMs).toBeGreaterThan(0);
    expect(snapshotTimeoutMs).toBeLessThanOrEqual(4321);
    expect(snapshotSignal).not.toBe(controller.signal);
    controller.abort(new Error("cancelled after capture"));
    expect(snapshotSignal?.aborted).toBe(true);
  });

  it("keeps direct CDP capture and ref publication under one deadline", async () => {
    vi.useFakeTimers();
    try {
      pwMocks.getModule.mockResolvedValueOnce({
        getObservedBrowserStateViaPlaywright: pwMocks.getObservedBrowserStateViaPlaywright,
        snapshotAriaViaPlaywright: pwMocks.snapshotAriaViaPlaywright,
        storeAriaSnapshotRefsViaPlaywright: pwMocks.storeAriaSnapshotRefsViaPlaywright,
      });
      cdpMocks.snapshotAria.mockResolvedValueOnce({ nodes: [] });
      pwMocks.storeAriaSnapshotRefsViaPlaywright.mockImplementationOnce(
        async (opts: { signal?: AbortSignal }) =>
          await new Promise<void>((_resolve, reject) => {
            opts.signal?.addEventListener(
              "abort",
              () => reject(opts.signal?.reason ?? new Error("aborted")),
              { once: true },
            );
          }),
      );
      const handler = getSnapshotHandler();
      const response = createBrowserRouteResponse();

      const pending = handler?.(
        { params: {}, query: { format: "aria", timeoutMs: "4321" } },
        response.res,
      );
      void pending?.catch(() => {});
      await vi.waitFor(() =>
        expect(pwMocks.storeAriaSnapshotRefsViaPlaywright).toHaveBeenCalledOnce(),
      );

      const snapshotSignal = (
        cdpMocks.snapshotAria.mock.calls[0]?.[0] as { signal?: AbortSignal } | undefined
      )?.signal;
      const storeSignal = (
        pwMocks.storeAriaSnapshotRefsViaPlaywright.mock.calls[0]?.[0] as
          | { signal?: AbortSignal }
          | undefined
      )?.signal;
      expect(storeSignal).toBe(snapshotSignal);

      await vi.advanceTimersByTimeAsync(4321);

      await expect(pending).rejects.toThrow(
        "Browser snapshot timed out after 4321ms (targetId=tab-1, method=ref storage)",
      );
      expect(storeSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds Playwright document identity reads with the route snapshot deadline", async () => {
    vi.useFakeTimers();
    try {
      pwMocks.getMainFrameDocumentIdentityViaPlaywright.mockImplementationOnce(
        async (opts: { signal?: AbortSignal }) =>
          await new Promise<string | undefined>((_resolve, reject) => {
            opts.signal?.addEventListener(
              "abort",
              () => reject(opts.signal?.reason ?? new Error("aborted")),
              { once: true },
            );
          }),
      );
      pwMocks.getModule.mockResolvedValueOnce({
        getObservedBrowserStateViaPlaywright: pwMocks.getObservedBrowserStateViaPlaywright,
        getMainFrameDocumentIdentityViaPlaywright:
          pwMocks.getMainFrameDocumentIdentityViaPlaywright,
        snapshotAriaViaPlaywright: pwMocks.snapshotAriaViaPlaywright,
        storeAriaSnapshotRefsViaPlaywright: pwMocks.storeAriaSnapshotRefsViaPlaywright,
      });
      const handler = getSnapshotHandler();
      const response = createBrowserRouteResponse();

      const pending = handler?.(
        { params: {}, query: { format: "aria", timeoutMs: "1000" } },
        response.res,
      );
      void pending?.catch(() => {});
      await vi.waitFor(() =>
        expect(pwMocks.getMainFrameDocumentIdentityViaPlaywright).toHaveBeenCalledOnce(),
      );

      await vi.advanceTimersByTimeAsync(1000);

      await expect(pending).rejects.toThrow(
        "Browser snapshot timed out after 1000ms (targetId=tab-1, method=Page.getFrameTree)",
      );
      const identitySignal = (
        pwMocks.getMainFrameDocumentIdentityViaPlaywright.mock.calls[0]?.[0] as
          | { signal?: AbortSignal }
          | undefined
      )?.signal;
      expect(identitySignal?.aborted).toBe(true);
      expect(cdpMocks.snapshotAria).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart an aborted Playwright role snapshot through CDP fallback", async () => {
    pwMocks.snapshotRoleViaPlaywright.mockImplementationOnce(
      async (opts: { signal?: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          opts.signal?.addEventListener(
            "abort",
            () => reject(opts.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    );
    pwMocks.getModule.mockResolvedValue({
      getObservedBrowserStateViaPlaywright: pwMocks.getObservedBrowserStateViaPlaywright,
      getMainFrameDocumentIdentityViaPlaywright: pwMocks.getMainFrameDocumentIdentityViaPlaywright,
      snapshotRoleViaPlaywright: pwMocks.snapshotRoleViaPlaywright,
    });
    const handler = getSnapshotHandler();
    const response = createBrowserRouteResponse();
    const controller = new AbortController();

    const pending = handler?.(
      {
        params: {},
        query: { format: "ai", interactive: "true", timeoutMs: "4321" },
        signal: controller.signal,
      },
      response.res,
    );
    void pending?.catch(() => {});
    await vi.waitFor(() => expect(pwMocks.snapshotRoleViaPlaywright).toHaveBeenCalledOnce());

    controller.abort(new Error("request cancelled"));

    await expect(pending).rejects.toThrow("request cancelled");
    expect(cdpMocks.snapshotRoleViaCdp).not.toHaveBeenCalled();
  });

  it("passes route cancellation to Playwright aria snapshots", async () => {
    pwMocks.getModule.mockResolvedValueOnce({
      getObservedBrowserStateViaPlaywright: pwMocks.getObservedBrowserStateViaPlaywright,
      snapshotAriaViaPlaywright: pwMocks.snapshotAriaViaPlaywright,
      storeAriaSnapshotRefsViaPlaywright: pwMocks.storeAriaSnapshotRefsViaPlaywright,
    });
    pwMocks.requireModule.mockResolvedValueOnce({
      snapshotAriaViaPlaywright: pwMocks.snapshotAriaViaPlaywright,
    });
    profileContext.ensureTabAvailable.mockResolvedValueOnce({
      targetId: "tab-1",
      url: "https://example.com",
      wsUrl: undefined,
    });
    const handler = getSnapshotHandler();
    const response = createBrowserRouteResponse();
    const controller = new AbortController();

    await handler?.(
      {
        params: {},
        query: { format: "aria", timeoutMs: "4321" },
        signal: controller.signal,
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(pwMocks.snapshotAriaViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "tab-1",
        timeoutMs: 4321,
        signal: expect.any(AbortSignal),
      }),
    );
    const snapshotSignal = (
      pwMocks.snapshotAriaViaPlaywright.mock.calls[0]?.[0] as { signal?: AbortSignal } | undefined
    )?.signal;
    expect(snapshotSignal).not.toBe(controller.signal);
    controller.abort(new Error("cancelled after capture"));
    expect(snapshotSignal?.aborted).toBe(true);
  });

  it("passes timeoutMs to direct CDP role snapshots", async () => {
    const handler = getSnapshotHandler();
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai", timeoutMs: "9876" } }, response.res);

    expect(response.statusCode).toBe(200);
    expect(cdpMocks.snapshotRoleViaCdp).toHaveBeenCalledWith(
      expect.objectContaining({
        wsUrl: "ws://127.0.0.1:18800/devtools/page/tab-1",
        signal: expect.any(AbortSignal),
      }),
    );
    const timeoutMs = (
      cdpMocks.snapshotRoleViaCdp.mock.calls[0]?.[0] as { timeoutMs?: number } | undefined
    )?.timeoutMs;
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(9876);
  });

  it("caps screenshot timeoutMs before dispatching to CDP", async () => {
    cdpMocks.captureScreenshot.mockResolvedValueOnce(Buffer.from("png"));
    const handler = getScreenshotHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      { params: {}, query: {}, body: { type: "png", timeoutMs: 3_000_000_000 } },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(cdpMocks.captureScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 2_147_483_647,
      }),
    );
  });

  it("rejects loose screenshot timeoutMs values before dispatching", async () => {
    const handler = getScreenshotHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      { params: {}, query: {}, body: { type: "png", timeoutMs: "1e3" } },
      response.res,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "timeoutMs must be a positive integer." });
    expect(cdpMocks.captureScreenshot).not.toHaveBeenCalled();
  });
});
