// Browser tests cover agent.act.existing session navigation guard plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExistingSessionAgentSharedModule,
  existingSessionRouteState,
} from "./existing-session.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const chromeMcpMocks = vi.hoisted(() => ({
  clickChromeMcpCoords: vi.fn(async () => {}),
  clickChromeMcpElement: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(
    async (_params: unknown): Promise<unknown> => "https://example.com",
  ),
  fillChromeMcpElement: vi.fn(async () => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  handleChromeMcpDialog: vi.fn(async () => false),
  hoverChromeMcpElement: vi.fn(async () => {}),
  pressChromeMcpKey: vi.fn(async () => {}),
  resizeChromeMcpPage: vi.fn(async () => {}),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(
    async (_opts?: { url: string; ssrfPolicy?: unknown }) => {},
  ),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../chrome-mcp.js", () => ({
  clickChromeMcpCoords: chromeMcpMocks.clickChromeMcpCoords,
  clickChromeMcpElement: chromeMcpMocks.clickChromeMcpElement,
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: chromeMcpMocks.dragChromeMcpElement,
  evaluateChromeMcpScript: chromeMcpMocks.evaluateChromeMcpScript,
  fillChromeMcpElement: chromeMcpMocks.fillChromeMcpElement,
  fillChromeMcpForm: chromeMcpMocks.fillChromeMcpForm,
  handleChromeMcpDialog: chromeMcpMocks.handleChromeMcpDialog,
  hoverChromeMcpElement: chromeMcpMocks.hoverChromeMcpElement,
  pressChromeMcpKey: chromeMcpMocks.pressChromeMcpKey,
  resizeChromeMcpPage: chromeMcpMocks.resizeChromeMcpPage,
}));

vi.mock("../navigation-guard.js", () => navigationGuardMocks);

vi.mock("./agent.shared.js", () => createExistingSessionAgentSharedModule());

const DEFAULT_SSRF_POLICY = { allowPrivateNetwork: false } as const;

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");
const {
  runExistingSessionActionWithNavigationGuard,
  runExistingSessionDialogResponseWithNavigationGuard,
} = await import("./agent.act.existing-session-navigation-guard.js");
const routeState = existingSessionRouteState;

function getActPostHandler(
  ssrfPolicy: { allowPrivateNetwork: false } | null = DEFAULT_SSRF_POLICY,
) {
  return getPostHandler("/act", ssrfPolicy);
}

function getPostHandler(
  path: "/act" | "/highlight",
  ssrfPolicy: { allowPrivateNetwork: false } | null = DEFAULT_SSRF_POLICY,
) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActRoutes(app, {
    state: () => ({
      resolved: {
        actionTimeoutMs: 60_000,
        evaluateEnabled: true,
        ssrfPolicy: ssrfPolicy ?? undefined,
      },
    }),
  } as never);
  const handler = postHandlers.get(path);
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("existing-session interaction navigation guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of Object.values(chromeMcpMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(navigationGuardMocks)) {
      fn.mockClear();
    }
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (_opts?: { url: string; ssrfPolicy?: unknown }) => {},
    );
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue("https://example.com");
    routeState.tab.url = "https://example.com";
    routeState.profileCtx.listTabs.mockReset();
    routeState.profileCtx.listTabs.mockResolvedValue([
      {
        targetId: "7",
        url: "https://example.com",
      },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runAction(
    body: Record<string, unknown>,
    ssrfPolicy: { allowPrivateNetwork: false } | null = DEFAULT_SSRF_POLICY,
  ) {
    const handler = getActPostHandler(ssrfPolicy);
    const response = createBrowserRouteResponse();
    const pending = handler?.({ params: {}, query: {}, body }, response.res);
    await vi.runAllTimersAsync();
    await pending;
    return response;
  }

  async function expectActionToReject(body: Record<string, unknown>) {
    await expectActionToThrow(body, "Unable to verify stable post-interaction navigation");
  }

  async function expectActionToThrow(body: Record<string, unknown>, message: string) {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    const pending = handler?.({ params: {}, query: {}, body }, response.res) ?? Promise.resolve();
    void pending.catch(() => {});
    const completion = (async () => {
      await vi.runAllTimersAsync();
      await pending;
    })();

    await expect(completion).rejects.toThrow(message);
  }

  async function runHighlight(ref = "btn-1") {
    const handler = getPostHandler("/highlight");
    const response = createBrowserRouteResponse();
    const pending = handler?.({ params: {}, query: {}, body: { ref } }, response.res);
    await vi.runAllTimersAsync();
    await pending;
    return response;
  }

  async function expectHighlightToThrow(message: string) {
    const handler = getPostHandler("/highlight");
    const response = createBrowserRouteResponse();
    const pending =
      handler?.({ params: {}, query: {}, body: { ref: "btn-1" } }, response.res) ??
      Promise.resolve();
    void pending.catch(() => {});
    const completion = (async () => {
      await vi.runAllTimersAsync();
      await pending;
    })();

    await expect(completion).rejects.toThrow(message);
  }

  function expectNavigationProbeUrls(urls: string[]) {
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledTimes(
      urls.length,
    );
    for (const [index, url] of urls.entries()) {
      expect(
        navigationGuardMocks.assertBrowserNavigationResultAllowed.mock.calls[index]?.[0]?.url,
      ).toBe(url);
    }
  }

  it("checks navigation after click and key-driven submit paths", async () => {
    const clickResponse = await runAction({ kind: "click", ref: "btn-1" });
    const typeResponse = await runAction({
      kind: "type",
      ref: "field-1",
      text: "hello",
      submit: true,
    });

    expect(clickResponse.statusCode).toBe(200);
    expect(typeResponse.statusCode).toBe(200);
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.pressChromeMcpKey).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter" }),
    );
    expectNavigationProbeUrls(Array.from({ length: 10 }, () => "https://example.com"));
  });

  it("checks navigation after an existing-session highlight scrolls its ref into view", async () => {
    const response = await runHighlight();

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        targetId: "7",
        args: ["btn-1"],
        fn: expect.stringContaining("scrollIntoView"),
      }),
    );
    expectNavigationProbeUrls(Array.from({ length: 5 }, () => "https://example.com"));
  });

  it("rejects highlight when its ref scroll changes the selected page to a private URL", async () => {
    const blockedUrl = "http://169.254.169.254/latest/meta-data/";
    let highlightRan = false;
    chromeMcpMocks.evaluateChromeMcpScript.mockImplementation(async (params: unknown) => {
      const fn = (params as { fn?: string }).fn;
      if (fn === "() => window.location.href") {
        return highlightRan ? blockedUrl : "https://example.com";
      }
      highlightRan = true;
      return true;
    });
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        if (opts?.url === blockedUrl) {
          throw new Error("blocked highlight destination");
        }
      },
    );

    await expectHighlightToThrow("blocked highlight destination");
    expect(chromeMcpMocks.evaluateChromeMcpScript.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ fn: expect.stringContaining("scrollIntoView") }),
    );
  });

  it("rejects a new private tab opened while highlighting an existing-session ref", async () => {
    const blockedUrl = "http://169.254.169.254/latest/meta-data/";
    routeState.profileCtx.listTabs
      .mockResolvedValueOnce([{ targetId: "7", url: "https://example.com" }])
      .mockResolvedValueOnce([
        { targetId: "7", url: "https://example.com" },
        { targetId: "8", url: blockedUrl },
      ]);
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        if (opts?.url === blockedUrl) {
          throw new Error("blocked highlight popup");
        }
      },
    );

    await expectHighlightToThrow("blocked highlight popup");
    expect(routeState.profileCtx.listTabs).toHaveBeenCalledTimes(2);
  });

  it("threads one request budget through coordinate actions and navigation probes", async () => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    const ctrl = new AbortController();
    const pending = handler?.(
      {
        params: {},
        query: {},
        body: { kind: "clickCoords", x: 20, y: 30 },
        signal: ctrl.signal,
      },
      response.res,
    );

    await vi.runAllTimersAsync();
    await pending;

    const expectedOptions = { signal: ctrl.signal, timeoutMs: 60_000 };
    expect(chromeMcpMocks.clickChromeMcpCoords).toHaveBeenCalledWith(
      expect.objectContaining(expectedOptions),
    );
    for (const [params] of chromeMcpMocks.evaluateChromeMcpScript.mock.calls) {
      expect(params).toEqual(expect.objectContaining(expectedOptions));
    }
    expect(routeState.profileCtx.listTabs).toHaveBeenCalledWith(expectedOptions);
  });

  it("cancels a pending existing-session wait when its request aborts", async () => {
    const handler = getActPostHandler(null);
    const response = createBrowserRouteResponse();
    const ctrl = new AbortController();
    const pending = handler?.(
      {
        params: {},
        query: {},
        body: { kind: "wait", timeMs: 30_000 },
        signal: ctrl.signal,
      },
      response.res,
    );
    void pending?.catch(() => {});

    ctrl.abort(new Error("request cancelled after browser crash"));

    await expect(pending).rejects.toThrow(/aborted|cancelled/i);
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("checks navigation after an existing-session wait predicate runs", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValue("https://example.com" as never);

    const response = await runAction({
      kind: "wait",
      fn: "() => { location.href = 'https://example.com'; return true; }",
    });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(6);
    expect(chromeMcpMocks.evaluateChromeMcpScript.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        targetId: "7",
        fn: expect.stringContaining("location.href"),
      }),
    );
    expectNavigationProbeUrls(Array.from({ length: 5 }, () => "https://example.com"));
  });

  it.each([
    ["expression", "window.ready === true", "const __openclawEvaluateExpressionResult"],
    ["statement body", "return window.ready === true;", "async () =>"],
  ])("normalizes %s existing-session wait predicates", async (_label, fn, expectedSource) => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValue("https://example.com" as never);

    const response = await runAction({ kind: "wait", fn });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        targetId: "7",
        fn: expect.stringContaining(expectedSource),
      }),
    );
  });

  it("re-polls false existing-session wait predicates", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValue("https://example.com" as never);

    const response = await runAction({ kind: "wait", fn: "async () => window.ready === true" });

    expect(response.statusCode).toBe(200);
    const predicateCalls = chromeMcpMocks.evaluateChromeMcpScript.mock.calls.filter(([params]) =>
      (params as { fn?: string }).fn?.includes("window.ready === true"),
    );
    expect(predicateCalls).toHaveLength(2);
  });

  it("checks navigation after an existing-session viewport resize", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue("https://target.example");
    const response = await runAction({ kind: "resize", width: 800, height: 600 });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.resizeChromeMcpPage).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "7", width: 800, height: 600 }),
    );
    expectNavigationProbeUrls([]);
  });

  it("preserves resize on an unchanged disallowed existing-session tab", async () => {
    const privateUrl = "http://127.0.0.1:8080/admin";
    routeState.tab.url = privateUrl;
    routeState.profileCtx.listTabs.mockResolvedValue([{ targetId: "7", url: privateUrl }]);
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue(privateUrl);

    const response = await runAction({ kind: "resize", width: 800, height: 600 });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.resizeChromeMcpPage).toHaveBeenCalledOnce();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("derives the resize exemption from the exact immediate location probe", async () => {
    const staleUrl = "http://169.254.169.254/latest/meta-data/";
    const exactUrl = "http://127.0.0.1:8080/current";
    routeState.tab.url = staleUrl;
    routeState.profileCtx.listTabs.mockResolvedValue([{ targetId: "7", url: staleUrl }]);
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue(exactUrl);

    const response = await runAction({ kind: "resize", width: 800, height: 600 });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.resizeChromeMcpPage).toHaveBeenCalledOnce();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("rejects resize when the selected page changes to a private URL", async () => {
    const privateUrl = "http://169.254.169.254/latest/meta-data/";
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com")
      .mockResolvedValue(privateUrl);
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        if (opts?.url === privateUrl) {
          throw new Error("blocked changed destination");
        }
      },
    );

    await expectActionToThrow(
      { kind: "resize", width: 800, height: 600 },
      "blocked changed destination",
    );
    expect(chromeMcpMocks.resizeChromeMcpPage).not.toHaveBeenCalled();
  });

  it("rejects a new private tab opened by resize on an unchanged private page", async () => {
    const privateUrl = "http://127.0.0.1:8080/admin";
    const blockedUrl = "http://169.254.169.254/latest/meta-data/";
    routeState.tab.url = privateUrl;
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue(privateUrl);
    routeState.profileCtx.listTabs
      .mockResolvedValueOnce([{ targetId: "7", url: privateUrl }])
      .mockResolvedValueOnce([
        { targetId: "7", url: privateUrl },
        { targetId: "8", url: blockedUrl },
      ]);
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        if (opts?.url === blockedUrl) {
          throw new Error("blocked new tab");
        }
      },
    );

    await expectActionToThrow({ kind: "resize", width: 800, height: 600 }, "blocked new tab");
  });

  it("rechecks the page url after delayed navigation-triggering interactions", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce(42 as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("http://169.254.169.254/latest/meta-data/" as never)
      .mockResolvedValueOnce("http://169.254.169.254/latest/meta-data/" as never);

    const response = await runAction({ kind: "evaluate", fn: "() => document.title" });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(6);
    expectNavigationProbeUrls([
      "https://example.com",
      "https://example.com",
      "https://example.com",
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.169.254/latest/meta-data/",
    ]);
  });

  it("normalizes statement-body evaluate sources before Chrome MCP execution", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(42 as never);

    const response = await runAction(
      { kind: "evaluate", fn: "const value = 41; return value + 1;" },
      null,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({
        fn: "async () => {\nconst value = 41; return value + 1;\n}",
      }),
    );
  });

  it("normalizes ref-scoped statement-body evaluate sources before Chrome MCP execution", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce("Ada" as never);

    const response = await runAction(
      { kind: "evaluate", ref: "7", fn: "const text = el.textContent; return text;" },
      null,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["7"],
        fn: "async (el) => {\nconst text = el.textContent; return text;\n}",
      }),
    );
  });

  it("blocks evaluate before execution when the current tab URL is disallowed", async () => {
    routeState.tab.url = "http://169.254.169.254/latest/meta-data/";
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        const url = opts?.url ?? "";
        if (url.includes("169.254.169.254")) {
          throw new Error("blocked current tab");
        }
      },
    );

    await expectActionToThrow(
      { kind: "evaluate", fn: "() => document.body.innerText" },
      "blocked current tab",
    );
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
    expectNavigationProbeUrls(["http://169.254.169.254/latest/meta-data/"]);
  });

  it("rechecks the exact target URL after an asynchronous preflight before execution", async () => {
    const safeUrl = "https://example.com";
    const blockedUrl = "http://169.254.169.254/latest/meta-data/";
    let currentUrl = safeUrl;
    let resolveFirstAssertion: (() => void) | undefined;
    let markFirstAssertionStarted: (() => void) | undefined;
    const firstAssertionStarted = new Promise<void>((resolve) => {
      markFirstAssertionStarted = resolve;
    });

    chromeMcpMocks.evaluateChromeMcpScript.mockImplementation(async (params: unknown) => {
      const fn = (params as { fn?: string }).fn;
      if (fn === "() => window.location.href") {
        return currentUrl;
      }
      throw new Error("interaction execution unexpectedly started");
    });
    let safeUrlChecks = 0;
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        if (opts?.url === safeUrl) {
          safeUrlChecks += 1;
          if (safeUrlChecks === 2) {
            markFirstAssertionStarted?.();
            await new Promise<void>((resolve) => {
              resolveFirstAssertion = resolve;
            });
          }
          return;
        }
        if (opts?.url === blockedUrl) {
          throw new Error("blocked URL changed during preflight");
        }
      },
    );

    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    const pending =
      handler?.(
        {
          params: {},
          query: {},
          body: { kind: "evaluate", fn: "() => document.body.innerText" },
        },
        response.res,
      ) ?? Promise.resolve();
    void pending.catch(() => {});

    await firstAssertionStarted;
    currentUrl = blockedUrl;
    resolveFirstAssertion?.();

    await expect(pending).rejects.toThrow("blocked URL changed during preflight");
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(2);
    expect(
      chromeMcpMocks.evaluateChromeMcpScript.mock.calls.map(
        ([params]) => (params as { fn?: string }).fn,
      ),
    ).toEqual(["() => window.location.href", "() => window.location.href"]);
    expectNavigationProbeUrls([safeUrl, safeUrl, blockedUrl]);
  });

  it("requires a retry when the exact target changes to another allowed URL during preflight", async () => {
    const execute = vi.fn(async () => "unexpected");
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://first.example")
      .mockResolvedValueOnce("https://second.example");

    await expect(
      runExistingSessionActionWithNavigationGuard({
        execute,
        guard: {
          profileName: "chrome-live",
          targetId: "7",
          ssrfPolicy: DEFAULT_SSRF_POLICY,
          listTabs: vi.fn(async () => [{ targetId: "7", url: "https://first.example" }]),
        },
      }),
    ).rejects.toThrow("changed during navigation policy preflight");

    expect(execute).not.toHaveBeenCalled();
    expectNavigationProbeUrls(["https://first.example", "https://second.example"]);
  });

  it("checks URLs for tabs opened during the interaction window", async () => {
    routeState.profileCtx.listTabs
      .mockResolvedValueOnce([
        {
          targetId: "7",
          url: "https://example.com",
        },
      ])
      .mockResolvedValueOnce([
        {
          targetId: "7",
          url: "https://example.com",
        },
        {
          targetId: "9",
          url: "http://169.254.169.254/latest/meta-data/",
        },
      ]);

    const response = await runAction({ kind: "click", ref: "btn-1" });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledOnce();
    expectNavigationProbeUrls([
      "https://example.com",
      "https://example.com",
      "https://example.com",
      "https://example.com",
      "https://example.com",
      "http://169.254.169.254/latest/meta-data/",
    ]);
  });

  it("fails closed when a newly opened tab URL is blocked", async () => {
    routeState.profileCtx.listTabs
      .mockResolvedValueOnce([
        {
          targetId: "7",
          url: "https://example.com",
        },
      ])
      .mockResolvedValueOnce([
        {
          targetId: "7",
          url: "https://example.com",
        },
        {
          targetId: "9",
          url: "http://169.254.169.254/latest/meta-data/",
        },
      ]);
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        const url = opts?.url ?? "";
        if (url.includes("169.254.169.254")) {
          throw new Error("blocked new tab");
        }
      },
    );

    await expectActionToThrow({ kind: "click", ref: "btn-1" }, "blocked new tab");
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledOnce();
  });

  it("fails closed when an existing sibling tab changes to a blocked URL", async () => {
    const blockedUrl = "http://169.254.169.254/latest/meta-data/";
    routeState.profileCtx.listTabs
      .mockResolvedValueOnce([
        { targetId: "7", url: "https://example.com" },
        { targetId: "9", url: "https://safe.example/child" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", url: "https://example.com" },
        { targetId: "9", url: blockedUrl },
      ]);
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        if (opts?.url === blockedUrl) {
          throw new Error("blocked changed sibling tab");
        }
      },
    );

    await expectActionToThrow({ kind: "click", ref: "btn-1" }, "blocked changed sibling tab");
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledOnce();
  });

  it("fails closed when location probes never return a usable url", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("result" as never)
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce("   " as never);

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
    expectNavigationProbeUrls(["https://example.com", "https://example.com"]);
  });

  it("fails closed when a later post-action probe becomes unreadable", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com" as never) // immediate preflight
      .mockResolvedValueOnce("https://example.com" as never) // pre-execute recheck
      .mockResolvedValueOnce("result" as never) // action evaluate
      .mockResolvedValueOnce("https://example.com" as never) // location probe 1
      .mockResolvedValueOnce(undefined as never) // location probe 2 - unreadable
      .mockResolvedValueOnce(undefined as never); // location probe 3 - unreadable

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
    expectNavigationProbeUrls([
      "https://example.com",
      "https://example.com",
      "https://example.com",
    ]);
  });

  it("does not treat matching reads separated by a blind interval as stable", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("result" as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockRejectedValueOnce(new Error("context destroyed") as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockRejectedValueOnce(new Error("context destroyed") as never);

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(7);
  });

  it("confirms stability via follow-up probe when URL changes on the last loop iteration", async () => {
    // Immediate preflight: reads the current safe URL.
    // Action evaluate: returns the action value.
    // Location probe 1 (0ms): fails (context churn)
    // Location probe 2 (250ms): reads safe URL A
    // Location probe 3 (500ms): reads safe URL B (late navigation)
    // Follow-up probe (500ms later): reads URL B again → stable, success
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com" as never) // immediate preflight
      .mockResolvedValueOnce("https://example.com" as never) // pre-execute recheck
      .mockResolvedValueOnce("result" as never) // action evaluate result
      .mockRejectedValueOnce(new Error("context churn") as never) // location probe 1 fails
      .mockResolvedValueOnce("https://example.com" as never) // location probe 2: URL A
      .mockResolvedValueOnce("https://safe-redirect.com" as never) // location probe 3: URL B (changed)
      .mockResolvedValueOnce("https://safe-redirect.com" as never); // follow-up: URL B again → stable

    const response = await runAction({ kind: "evaluate", fn: "() => 1" });

    expect(response.statusCode).toBe(200);
    // 1 action call + 2 preflight reads + 4 post-action probes.
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(7);
    expectNavigationProbeUrls([
      "https://example.com",
      "https://example.com",
      "https://example.com",
      "https://safe-redirect.com",
      "https://safe-redirect.com",
    ]);
  });

  it("keeps probing through the full window before declaring navigation stable", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com" as never) // immediate preflight
      .mockResolvedValueOnce("https://example.com" as never) // pre-execute recheck
      .mockResolvedValueOnce("result" as never) // action evaluate result
      .mockResolvedValueOnce("https://example.com" as never) // location probe 1
      .mockResolvedValueOnce("https://example.com" as never) // location probe 2
      .mockResolvedValueOnce("https://safe-redirect.com" as never) // location probe 3
      .mockResolvedValueOnce("https://safe-redirect.com" as never); // follow-up confirms late redirect

    const response = await runAction({ kind: "evaluate", fn: "() => 1" });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(7);
    expectNavigationProbeUrls([
      "https://example.com",
      "https://example.com",
      "https://example.com",
      "https://example.com",
      "https://safe-redirect.com",
      "https://safe-redirect.com",
    ]);
  });

  it("fails closed when follow-up probe sees yet another URL change", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com" as never) // immediate preflight
      .mockResolvedValueOnce("https://example.com" as never) // pre-execute recheck
      .mockResolvedValueOnce("result" as never) // action evaluate result
      .mockResolvedValueOnce("https://a.com" as never) // location probe 1
      .mockResolvedValueOnce("https://b.com" as never) // location probe 2: changed
      .mockResolvedValueOnce("https://c.com" as never) // location probe 3: changed again
      .mockResolvedValueOnce("https://d.com" as never); // follow-up: still changing

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
  });

  it("preserves a policy denial from the follow-up probe", async () => {
    const blockedUrl = "http://169.254.169.254/latest/meta-data/";
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("result" as never)
      .mockResolvedValueOnce("https://a.example" as never)
      .mockResolvedValueOnce("https://b.example" as never)
      .mockResolvedValueOnce("https://c.example" as never)
      .mockResolvedValueOnce(blockedUrl as never);
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        if (opts?.url === blockedUrl) {
          throw new Error("blocked follow-up destination");
        }
      },
    );

    await expectActionToThrow({ kind: "evaluate", fn: "() => 1" }, "blocked follow-up destination");
  });

  it("fails closed when a probe error follows two stable reads", async () => {
    // Probes 1 + 2 match (sawStableAllowedUrl would be true), probe 3 throws.
    // Guard must NOT return success — the throw invalidates prior stability.
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("https://example.com" as never) // immediate preflight
      .mockResolvedValueOnce("https://example.com" as never) // pre-execute recheck
      .mockResolvedValueOnce("result" as never) // action evaluate result
      .mockResolvedValueOnce("https://example.com" as never) // location probe 1
      .mockResolvedValueOnce("https://example.com" as never) // location probe 2 → stable pair
      .mockRejectedValueOnce(new Error("context destroyed") as never); // location probe 3 → error

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
    expectNavigationProbeUrls([
      "https://example.com",
      "https://example.com",
      "https://example.com",
      "https://example.com",
    ]);
  });

  it("skips the guard when no SSRF policy is configured", async () => {
    const response = await runAction({ kind: "press", key: "Enter" }, null);

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.pressChromeMcpKey).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
    expect(routeState.profileCtx.listTabs).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("uses the authoritative tab URL before handling an existing-session dialog", async () => {
    const execute = vi.fn(async () => false);
    const listTabs = vi.fn(async () => [{ targetId: "7", url: "https://dialog.example" }]);

    await expect(
      runExistingSessionDialogResponseWithNavigationGuard({
        execute,
        guard: {
          profileName: "chrome-live",
          targetId: "7",
          ssrfPolicy: DEFAULT_SSRF_POLICY,
          listTabs,
        },
      }),
    ).resolves.toBe(false);

    expect(execute).toHaveBeenCalledOnce();
    expect(listTabs).toHaveBeenCalledTimes(2);
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
    expectNavigationProbeUrls(["https://dialog.example"]);
  });

  it("rechecks the exact modal owner after an asynchronous preflight before dispatch", async () => {
    const safeUrl = "https://dialog.example";
    const blockedUrl = "http://169.254.169.254/latest/meta-data/";
    const execute = vi.fn(async () => true);
    const listTabs = vi
      .fn()
      .mockResolvedValueOnce([{ targetId: "7", url: safeUrl }])
      .mockResolvedValueOnce([{ targetId: "7", url: blockedUrl }]);
    let releaseSafeCheck: (() => void) | undefined;
    let markSafeCheckStarted: (() => void) | undefined;
    const safeCheckStarted = new Promise<void>((resolve) => {
      markSafeCheckStarted = resolve;
    });
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        if (opts?.url === safeUrl) {
          markSafeCheckStarted?.();
          await new Promise<void>((resolve) => {
            releaseSafeCheck = resolve;
          });
          return;
        }
        if (opts?.url === blockedUrl) {
          throw new Error("blocked modal owner changed during preflight");
        }
      },
    );

    const pending = runExistingSessionDialogResponseWithNavigationGuard({
      execute,
      guard: {
        profileName: "chrome-live",
        targetId: "7",
        ssrfPolicy: DEFAULT_SSRF_POLICY,
        listTabs,
      },
    });
    void pending.catch(() => {});
    await safeCheckStarted;
    releaseSafeCheck?.();

    await expect(pending).rejects.toThrow("blocked modal owner changed during preflight");
    expect(execute).not.toHaveBeenCalled();
    expect(listTabs).toHaveBeenCalledTimes(2);
    expectNavigationProbeUrls([safeUrl, blockedUrl]);
  });

  it("requires a retry when the modal owner changes to another allowed URL during preflight", async () => {
    const execute = vi.fn(async () => true);
    const listTabs = vi
      .fn()
      .mockResolvedValueOnce([{ targetId: "7", url: "https://first.example" }])
      .mockResolvedValueOnce([{ targetId: "7", url: "https://second.example" }]);

    await expect(
      runExistingSessionDialogResponseWithNavigationGuard({
        execute,
        guard: {
          profileName: "chrome-live",
          targetId: "7",
          ssrfPolicy: DEFAULT_SSRF_POLICY,
          listTabs,
        },
      }),
    ).rejects.toThrow("changed during navigation policy preflight");

    expect(execute).not.toHaveBeenCalled();
    expectNavigationProbeUrls(["https://first.example", "https://second.example"]);
  });

  it("runs the full postflight after handling an existing-session dialog", async () => {
    const execute = vi.fn(async () => true);
    const listTabs = vi.fn(async () => [{ targetId: "7", url: "https://dialog.example" }]);
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue("https://dialog.example");

    const pending = runExistingSessionDialogResponseWithNavigationGuard({
      execute,
      guard: {
        profileName: "chrome-live",
        targetId: "7",
        ssrfPolicy: DEFAULT_SSRF_POLICY,
        listTabs,
      },
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(listTabs).toHaveBeenCalledTimes(3);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(3);
    expectNavigationProbeUrls(Array.from({ length: 4 }, () => "https://dialog.example"));
  });

  it("blocks a pending-dialog response before dispatch when its listed URL is private", async () => {
    const blockedUrl = "http://169.254.169.254/latest/meta-data/";
    const execute = vi.fn(async () => true);
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (opts?: { url: string }) => {
        if (opts?.url === blockedUrl) {
          throw new Error("blocked pending dialog owner");
        }
      },
    );

    await expect(
      runExistingSessionDialogResponseWithNavigationGuard({
        execute,
        guard: {
          profileName: "chrome-live",
          targetId: "7",
          ssrfPolicy: DEFAULT_SSRF_POLICY,
          listTabs: async () => [{ targetId: "7", url: blockedUrl }],
        },
      }),
    ).rejects.toThrow("blocked pending dialog owner");

    expect(execute).not.toHaveBeenCalled();
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("still probes navigation when the interaction command throws", async () => {
    chromeMcpMocks.clickChromeMcpElement.mockImplementationOnce(() => {
      throw new Error("stale element");
    });

    await expectActionToThrow({ kind: "click", ref: "btn-1" }, "stale element");
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalled();
  });
});
