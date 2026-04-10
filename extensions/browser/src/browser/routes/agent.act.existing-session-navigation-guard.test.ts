import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const routeState = vi.hoisted(() => ({
  profileCtx: {
    profile: {
      driver: "existing-session" as const,
      name: "chrome-live",
    },
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "7",
      url: "https://example.com",
    })),
  },
  tab: {
    targetId: "7",
    url: "https://example.com",
  },
}));

const chromeMcpMocks = vi.hoisted(() => ({
  clickChromeMcpElement: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(async () => "https://example.com"),
  fillChromeMcpElement: vi.fn(async () => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  hoverChromeMcpElement: vi.fn(async () => {}),
  pressChromeMcpKey: vi.fn(async () => {}),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../chrome-mcp.js", () => ({
  clickChromeMcpElement: chromeMcpMocks.clickChromeMcpElement,
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: chromeMcpMocks.dragChromeMcpElement,
  evaluateChromeMcpScript: chromeMcpMocks.evaluateChromeMcpScript,
  fillChromeMcpElement: chromeMcpMocks.fillChromeMcpElement,
  fillChromeMcpForm: chromeMcpMocks.fillChromeMcpForm,
  hoverChromeMcpElement: chromeMcpMocks.hoverChromeMcpElement,
  pressChromeMcpKey: chromeMcpMocks.pressChromeMcpKey,
  resizeChromeMcpPage: vi.fn(async () => {}),
}));

vi.mock("../navigation-guard.js", () => navigationGuardMocks);

vi.mock("./agent.shared.js", () => ({
  getPwAiModule: vi.fn(async () => null),
  handleRouteError: vi.fn(),
  readBody: vi.fn((req: BrowserRequest) => req.body ?? {}),
  requirePwAi: vi.fn(async () => {
    throw new Error("Playwright should not be used for existing-session tests");
  }),
  resolveProfileContext: vi.fn(() => routeState.profileCtx),
  resolveTargetIdFromBody: vi.fn((body: Record<string, unknown>) =>
    typeof body.targetId === "string" ? body.targetId : undefined,
  ),
  withPlaywrightRouteContext: vi.fn(),
  withRouteTabContext: vi.fn(async ({ run }: { run: (args: unknown) => Promise<void> }) => {
    await run({
      profileCtx: routeState.profileCtx,
      cdpUrl: "http://127.0.0.1:18800",
      tab: routeState.tab,
    });
  }),
}));

const DEFAULT_SSRF_POLICY = { allowPrivateNetwork: false } as const;

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");

function getActPostHandler(ssrfPolicy?: { allowPrivateNetwork: false }) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActRoutes(app, {
    state: () => ({
      resolved: {
        evaluateEnabled: true,
        ssrfPolicy: ssrfPolicy ?? DEFAULT_SSRF_POLICY,
      },
    }),
  } as never);
  const handler = postHandlers.get("/act");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("existing-session interaction navigation guard", () => {
  beforeEach(() => {
    for (const fn of Object.values(chromeMcpMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(navigationGuardMocks)) {
      fn.mockClear();
    }
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue("https://example.com");
  });

  it("checks navigation after click and key-driven submit paths", async () => {
    const handler = getActPostHandler();

    const clickResponse = createBrowserRouteResponse();
    await handler?.(
      { params: {}, query: {}, body: { kind: "click", ref: "btn-1" } },
      clickResponse.res,
    );

    const typeResponse = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "type", ref: "field-1", text: "hello", submit: true },
      },
      typeResponse.res,
    );

    expect(clickResponse.statusCode).toBe(200);
    expect(typeResponse.statusCode).toBe(200);
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.pressChromeMcpKey).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter" }),
    );
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledTimes(4);
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ url: "https://example.com" }),
    );
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ url: "https://example.com" }),
    );
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ url: "https://example.com" }),
    );
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ url: "https://example.com" }),
    );
  });

  it("rechecks the page url after delayed navigation-triggering interactions", async () => {
    const handler = getActPostHandler();
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce(42 as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("http://169.254.169.254/latest/meta-data/" as never)
      .mockResolvedValueOnce("http://169.254.169.254/latest/meta-data/" as never);

    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "evaluate", fn: "() => document.title" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(4);
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ url: "https://example.com" }),
    );
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ url: "http://169.254.169.254/latest/meta-data/" }),
    );
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ url: "http://169.254.169.254/latest/meta-data/" }),
    );
  });

  it("skips the guard when no SSRF policy is configured", async () => {
    const { app, postHandlers } = createBrowserRouteApp();
    registerBrowserAgentActRoutes(app, {
      state: () => ({
        resolved: {
          evaluateEnabled: true,
          ssrfPolicy: undefined,
        },
      }),
    } as never);
    const handler = postHandlers.get("/act");
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: {}, body: { kind: "press", key: "Enter" } }, response.res);

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.pressChromeMcpKey).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });
});
