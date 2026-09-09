// Browser tests cover agent.act.existing session navigation guard plugin behavior.
import { setTimeout as sleep } from "node:timers/promises";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMcpOperationOptions } from "../chrome-mcp.js";
import { browserAct } from "../client-actions-core.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import type { BrowserDispatchRequest, BrowserDispatchResponse } from "./dispatcher.js";
import {
  createExistingSessionAgentSharedModule,
  existingSessionRouteState,
} from "./existing-session.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    // Drive both route sleeps and synthetic MCP work with the test's global clock.
    setTimeout: <T = void>(
      delay?: number,
      value?: T,
      options?: Parameters<typeof actual.setTimeout>[2],
    ) =>
      new Promise<T | undefined>((resolve, reject) => {
        const signal = options?.signal;
        signal?.throwIfAborted();
        const abort = () => {
          clearTimeout(timer);
          reject(toErrorObject(signal?.reason, "Browser action cancelled"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        }, delay);
        signal?.addEventListener("abort", abort, { once: true });
      }),
  };
});

const chromeMcpMocks = vi.hoisted(() => ({
  ChromeMcpDocumentUnavailableError: class ChromeMcpDocumentUnavailableError extends Error {},
  clickChromeMcpCoords: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  clickChromeMcpElement: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(
    async (_params: ChromeMcpOperationOptions) => "https://example.com",
  ),
  fillChromeMcpElement: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  hoverChromeMcpElement: vi.fn(async () => {}),
  pressChromeMcpKey: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  withChromeMcpDocument: vi.fn(
    async (_params: unknown, task: (document: { evaluate: (fn: string) => unknown }) => unknown) =>
      await task({
        evaluate: async (fn) =>
          fn.includes("globalThis.location.href")
            ? "https://example.com"
            : { kind: "result", ready: true },
      }),
  ),
}));

const transportMocks = vi.hoisted(() => ({
  dispatch: vi.fn<(request: BrowserDispatchRequest) => Promise<BrowserDispatchResponse>>(),
}));

vi.mock("../local-dispatch.runtime.js", () => ({
  dispatchBrowserControlRequest: transportMocks.dispatch,
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  const syntheticConfig = {
    browser: {
      defaultProfile: "chrome-live",
      profiles: { "chrome-live": { driver: "existing-session", color: "#123456" } },
    },
  };
  return {
    ...actual,
    getRuntimeConfig: () => syntheticConfig,
    loadConfig: () => syntheticConfig,
  };
});

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(
    async (_opts?: { url: string; ssrfPolicy?: unknown }) => {},
  ),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../chrome-mcp.js", () => ({
  ChromeMcpDocumentUnavailableError: chromeMcpMocks.ChromeMcpDocumentUnavailableError,
  clickChromeMcpCoords: chromeMcpMocks.clickChromeMcpCoords,
  clickChromeMcpElement: chromeMcpMocks.clickChromeMcpElement,
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: chromeMcpMocks.dragChromeMcpElement,
  evaluateChromeMcpScript: chromeMcpMocks.evaluateChromeMcpScript,
  fillChromeMcpElement: chromeMcpMocks.fillChromeMcpElement,
  fillChromeMcpForm: chromeMcpMocks.fillChromeMcpForm,
  hoverChromeMcpElement: chromeMcpMocks.hoverChromeMcpElement,
  pressChromeMcpKey: chromeMcpMocks.pressChromeMcpKey,
  resizeChromeMcpPage: vi.fn(async () => {}),
  withChromeMcpDocument: chromeMcpMocks.withChromeMcpDocument,
}));

vi.mock("../navigation-guard.js", () => navigationGuardMocks);

vi.mock("./agent.shared.js", () => createExistingSessionAgentSharedModule());

const DEFAULT_SSRF_POLICY = { allowPrivateNetwork: false } as const;
const GUARDED_TARGET_REFRESH_ACTIONS = [
  { kind: "hover", ref: "btn-1" },
  { kind: "scrollIntoView", ref: "btn-1" },
  { kind: "drag", startRef: "item-1", endRef: "slot-1" },
  { kind: "select", ref: "menu-1", values: ["alpha"] },
  { kind: "fill", fields: [{ ref: "input-1", value: "Ada" }] },
  { kind: "evaluate", fn: "() => document.title" },
] as const;

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");
const { resolveSafeRouteTabUrl, withRouteTabContext } = await import("./agent.shared.js");
const routeState = existingSessionRouteState;
const defaultResolveSafeRouteTabUrl = vi.mocked(resolveSafeRouteTabUrl).getMockImplementation();
if (!defaultResolveSafeRouteTabUrl) {
  throw new Error("missing existing-session URL resolver mock");
}
const defaultWithRouteTabContext = vi.mocked(withRouteTabContext).getMockImplementation();
if (!defaultWithRouteTabContext) {
  throw new Error("missing existing-session route context mock");
}

function getActPostHandler(
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
  const handler = postHandlers.get("/act");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("existing-session interaction navigation guard", () => {
  const clientControllers: AbortController[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of Object.values(chromeMcpMocks)) {
      if ("mockReset" in fn) {
        fn.mockReset();
      }
    }
    for (const fn of Object.values(navigationGuardMocks)) {
      fn.mockReset();
    }
    navigationGuardMocks.assertBrowserNavigationAllowed.mockResolvedValue(undefined);
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(
      async (_opts?: { url: string; ssrfPolicy?: unknown }) => {},
    );
    navigationGuardMocks.withBrowserNavigationPolicy.mockImplementation((ssrfPolicy?: unknown) =>
      ssrfPolicy ? { ssrfPolicy } : {},
    );
    chromeMcpMocks.clickChromeMcpCoords.mockResolvedValue(undefined);
    chromeMcpMocks.clickChromeMcpElement.mockResolvedValue(undefined);
    chromeMcpMocks.dragChromeMcpElement.mockResolvedValue(undefined);
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue("https://example.com");
    chromeMcpMocks.fillChromeMcpElement.mockResolvedValue(undefined);
    chromeMcpMocks.fillChromeMcpForm.mockResolvedValue(undefined);
    chromeMcpMocks.hoverChromeMcpElement.mockResolvedValue(undefined);
    chromeMcpMocks.pressChromeMcpKey.mockResolvedValue(undefined);
    transportMocks.dispatch.mockReset();
    vi.mocked(resolveSafeRouteTabUrl).mockReset().mockImplementation(defaultResolveSafeRouteTabUrl);
    vi.mocked(withRouteTabContext).mockReset().mockImplementation(defaultWithRouteTabContext);
    chromeMcpMocks.withChromeMcpDocument.mockImplementation(
      async (
        _params: unknown,
        task: (document: { evaluate: (fn: string) => unknown }) => unknown,
      ) =>
        await task({
          evaluate: async (fn) =>
            fn.includes("globalThis.location.href")
              ? "https://example.com"
              : { kind: "result", ready: true },
        }),
    );
    routeState.tab.url = "https://example.com";
    routeState.profileCtx.closeTab.mockReset();
    routeState.profileCtx.closeTab.mockResolvedValue(undefined);
    routeState.profileCtx.listTabs.mockReset();
    routeState.profileCtx.listTabs.mockResolvedValue([
      {
        targetId: "7",
        url: "https://example.com",
      },
    ]);
  });

  afterEach(async () => {
    try {
      for (const controller of clientControllers.splice(0)) {
        controller.abort(new Error("test cleanup"));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  async function startClientAction(
    body: BrowserActRequest,
    ssrfPolicy: { allowPrivateNetwork: false } | null = null,
  ) {
    const handler = getActPostHandler(ssrfPolicy);
    if (!handler) {
      throw new Error("missing /act handler");
    }
    transportMocks.dispatch.mockImplementation(async (request) => {
      const response = createBrowserRouteResponse();
      try {
        await handler(
          {
            params: {},
            query: request.query ?? {},
            body: request.body,
            signal: request.signal,
          },
          response.res,
        );
      } catch (error) {
        response.res.status(500).json({ error: String(error) });
      }
      return { status: response.statusCode, body: response.body };
    });
    const controller = new AbortController();
    clientControllers.push(controller);
    const settled = vi.fn();
    const completion = browserAct(undefined, body, {
      profile: "chrome-live",
      signal: controller.signal,
    }).then(
      (result) => {
        settled();
        return { result };
      },
      (error: unknown) => {
        settled();
        return { error };
      },
    );
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
    return { completion, settled };
  }

  function setWaitReadyAfter(delayMs: number) {
    const readyAt = Date.now() + delayMs;
    chromeMcpMocks.withChromeMcpDocument.mockImplementation(async (_params, task) =>
      task({
        evaluate: async (fn) =>
          fn.includes("globalThis.location.href")
            ? "https://example.com"
            : { kind: "result", ready: Date.now() >= readyAt },
      }),
    );
  }

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

  it("keeps a default existing-session wait alive past the managed wait deadline", async () => {
    setWaitReadyAfter(30_000);
    const request = await startClientAction({ kind: "wait", text: "ready" });

    await vi.advanceTimersByTimeAsync(25_001);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);

    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      result: { ok: true, targetId: "7", url: "https://example.com" },
    });
  });

  it.each([
    { name: "padded left button", input: { button: " left " } },
    { name: "blank selector beside a ref", input: { selector: " " } },
  ])("budgets a normalized click with $name through navigation verification", async ({ input }) => {
    chromeMcpMocks.clickChromeMcpElement.mockImplementationOnce(async ({ signal }) => {
      await sleep(40_000, undefined, { signal });
    });
    chromeMcpMocks.evaluateChromeMcpScript.mockImplementation(async ({ signal }) => {
      await sleep(10_000, undefined, { signal });
      return "https://example.com";
    });
    const request = await startClientAction(
      { kind: "click", ref: "button", ...input },
      DEFAULT_SSRF_POLICY,
    );

    await vi.advanceTimersByTimeAsync(65_001);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_749);

    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      result: { ok: true, targetId: "7", url: "https://example.com" },
    });
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(3);
  });

  it("lets an existing-session evaluation use its requested timeout beyond two minutes", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockImplementationOnce(async ({ signal }) => {
      await sleep(150_000, undefined, { signal });
      return "evaluation complete";
    });
    const request = await startClientAction({
      kind: "evaluate",
      fn: "() => window.ready",
      timeoutMs: 180_000,
    });

    await vi.advanceTimersByTimeAsync(125_251);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24_749);

    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      result: { ok: true, result: "evaluation complete" },
    });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 180_000 }),
    );
  });

  it("includes browser and tab preparation in the overall action deadline", async () => {
    const preparationSteps: string[] = [];
    vi.mocked(withRouteTabContext).mockImplementationOnce(async (params) => {
      await sleep(55_000, undefined, { signal: params.req.signal });
      preparationSteps.push("browser ready");
      await sleep(55_000, undefined, { signal: params.req.signal });
      preparationSteps.push("tab verified");
      return await defaultWithRouteTabContext(params);
    });
    let evaluationSignal: AbortSignal | undefined;
    chromeMcpMocks.evaluateChromeMcpScript.mockImplementationOnce(async ({ signal }) => {
      evaluationSignal = signal;
      await sleep(20_000, undefined, { signal });
      return "evaluation complete";
    });
    const request = await startClientAction({ kind: "evaluate", fn: "() => document.title" });

    await vi.advanceTimersByTimeAsync(121_249);
    expect(preparationSteps).toEqual(["browser ready", "tab verified"]);
    expect(evaluationSignal?.aborted).toBe(false);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(evaluationSignal?.aborted).toBe(true);
    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("Browser action request timed out after 121250ms"),
      }),
    });
    expect(transportMocks.dispatch.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  });

  it("cancels a slow submit at the shared body deadline after filling succeeds", async () => {
    const completed: string[] = [];
    let submitSignal: AbortSignal | undefined;
    chromeMcpMocks.fillChromeMcpElement.mockImplementationOnce(async ({ signal }) => {
      await sleep(45_000, undefined, { signal });
      completed.push("fill");
    });
    chromeMcpMocks.pressChromeMcpKey.mockImplementationOnce(async ({ signal }) => {
      submitSignal = signal;
      await sleep(45_000, undefined, { signal });
      completed.push("submit");
    });
    const request = await startClientAction({
      kind: "type",
      ref: "field",
      text: "hello",
      submit: true,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(completed).toEqual(["fill"]);
    expect(submitSignal?.aborted).toBe(false);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(submitSignal?.aborted).toBe(true);
    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("Browser action timed out after 60000ms"),
      }),
    });
    expect(completed).toEqual(["fill"]);
    expect(transportMocks.dispatch.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  });

  it("does not submit when filling completes after the body deadline before its timer runs", async () => {
    chromeMcpMocks.fillChromeMcpElement.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 60_001);
    });
    const request = await startClientAction({
      kind: "type",
      ref: "field",
      text: "hello",
      submit: true,
    });

    expect(chromeMcpMocks.fillChromeMcpElement).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.pressChromeMcpKey).not.toHaveBeenCalled();
    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("Browser action timed out after 60000ms"),
      }),
    });
  });

  it("bounds all post-action navigation probes by one verification deadline", async () => {
    const completedProbes: number[] = [];
    let probeSignal: AbortSignal | undefined;
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("evaluation complete")
      .mockImplementation(async ({ signal }) => {
        probeSignal = signal;
        await sleep(30_000, undefined, { signal });
        completedProbes.push(Date.now());
        return "https://example.com";
      });
    const request = await startClientAction(
      { kind: "evaluate", fn: "() => document.title" },
      DEFAULT_SSRF_POLICY,
    );

    await vi.advanceTimersByTimeAsync(61_249);
    expect(completedProbes).toHaveLength(2);
    expect(probeSignal?.aborted).toBe(false);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(probeSignal?.aborted).toBe(true);
    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("Browser navigation verification timed out after 61250ms"),
      }),
    });
    expect(completedProbes).toHaveLength(2);
    expect(transportMocks.dispatch.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  });

  it("cancels final URL resolution when the verification deadline expires", async () => {
    const actual = await vi.importActual<typeof import("./agent.shared.js")>("./agent.shared.js");
    let resolutionSignal: AbortSignal | undefined;
    vi.mocked(resolveSafeRouteTabUrl).mockImplementationOnce((params) =>
      actual.resolveSafeRouteTabUrl({
        ...params,
        profileCtx: {
          ...params.profileCtx,
          listTabs: async (options) => {
            resolutionSignal = options?.signal;
            await sleep(90_000, undefined, { signal: resolutionSignal });
            return [{ targetId: "7", title: "Fixture", url: "https://example.com" }];
          },
        },
      }),
    );
    const request = await startClientAction(
      { kind: "evaluate", fn: "() => document.title" },
      DEFAULT_SSRF_POLICY,
    );

    await vi.advanceTimersByTimeAsync(61_249);
    expect(resolutionSignal?.aborted).toBe(false);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(resolutionSignal?.aborted).toBe(true);
    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("Browser navigation verification timed out after 61250ms"),
      }),
    });
    expect(transportMocks.dispatch.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  });

  it.each(
    (
      [
        { name: "zero delay", body: { kind: "wait", timeMs: 0 }, durationMs: 0 },
        { name: "pure delay", body: { kind: "wait", timeMs: 30_000 }, durationMs: 30_000 },
        {
          name: "pure delay longer than the call timeout",
          body: { kind: "wait", timeMs: 1_000, timeoutMs: 500 },
          durationMs: 1_000,
        },
        {
          name: "condition after a delay",
          body: { kind: "wait", timeMs: 1_000, text: "ready", timeoutMs: 500 },
          durationMs: 1_250,
        },
      ] satisfies Array<{ name: string; body: BrowserActRequest; durationMs: number }>
    ).flatMap((entry) => [
      { ...entry, ssrfPolicy: null, verificationMs: 0 },
      {
        ...entry,
        name: `${entry.name} with navigation verification`,
        ssrfPolicy: DEFAULT_SSRF_POLICY,
        verificationMs: 750,
      },
    ]),
  )(
    "completes a healthy existing-session $name through the client transport",
    async ({ body, durationMs, ssrfPolicy, verificationMs }) => {
      setWaitReadyAfter(durationMs);
      const request = await startClientAction(body, ssrfPolicy);

      await vi.advanceTimersByTimeAsync(durationMs + verificationMs);

      expect(request.settled).toHaveBeenCalledOnce();
      expect(await request.completion).toMatchObject({ result: { ok: true, targetId: "7" } });
    },
  );

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
    expectNavigationProbeUrls(Array.from({ length: 8 }, () => "https://example.com"));
  });

  it("checks the bound document URL before evaluating a wait predicate", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce("https://example.com")
      .mockResolvedValueOnce({ kind: "result", ready: true });
    chromeMcpMocks.withChromeMcpDocument.mockImplementationOnce(
      async (_params, task) => await task({ evaluate }),
    );

    const response = await runAction({ kind: "wait", fn: "() => document.title === 'ready'" });

    expect(response.statusCode).toBe(200);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed.mock.calls[0]?.[0]?.url).toBe(
      "https://example.com",
    );
    expect(String(evaluate.mock.calls[1]?.[0])).toContain("document.title === 'ready'");
  });

  it("preserves promise-returning predicates inside the bound document", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce("https://example.com")
      .mockResolvedValueOnce({ kind: "result", ready: true });
    chromeMcpMocks.withChromeMcpDocument.mockImplementationOnce(
      async (_params, task) => await task({ evaluate }),
    );

    const response = await runAction({ kind: "wait", fn: "() => Promise.resolve(true)" });

    expect(response.statusCode).toBe(200);
    const script = String(evaluate.mock.calls[1]?.[0]);
    expect(script).toContain("Boolean(await");
    expect(routeState.profileCtx.closeTab).not.toHaveBeenCalled();
  });

  it("does not run a wait predicate in a document rejected by navigation policy", async () => {
    const evaluate = vi.fn().mockResolvedValue("http://169.254.169.254/latest/meta-data");
    chromeMcpMocks.withChromeMcpDocument.mockImplementationOnce(
      async (_params, task) => await task({ evaluate }),
    );
    navigationGuardMocks.assertBrowserNavigationResultAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("blocked document"));

    await expectActionToThrow({ kind: "wait", fn: "() => document.cookie" }, "blocked document");

    expect(evaluate).toHaveBeenCalledOnce();
    expect(String(evaluate.mock.calls[0]?.[0])).not.toContain("document.cookie");
  });

  it("rechecks a requested URL after a ready predicate mutates same-document history", async () => {
    chromeMcpMocks.withChromeMcpDocument.mockImplementation(async (_params, task) => {
      let urlReads = 0;
      return await task({
        evaluate: async (fn) => {
          if (!fn.includes("globalThis.location.href")) {
            return { kind: "result", ready: true };
          }
          urlReads += 1;
          if (urlReads === 2) {
            throw new Error("final URL rechecked");
          }
          return "https://example.com/ready";
        },
      });
    });

    await expectActionToThrow(
      {
        kind: "wait",
        url: "https://example.com/ready",
        fn: "() => { history.pushState({}, '', '/changed'); return true; }",
      },
      "final URL rechecked",
    );
  });

  it.each(GUARDED_TARGET_REFRESH_ACTIONS)(
    "does not adopt an unrelated target after guarded $kind interaction",
    async (body) => {
      routeState.profileCtx.listTabs
        .mockResolvedValueOnce([routeState.tab])
        .mockResolvedValue([{ targetId: "new-target", url: routeState.tab.url }]);

      const response = await runAction(body);

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        ok: true,
        targetId: routeState.tab.targetId,
        url: routeState.tab.url,
      });
    },
  );

  it.each(["coordinate action", "navigation verification"])(
    "propagates caller cancellation during %s without changing the MCP call timeout",
    async (phase) => {
      let operation: ChromeMcpOperationOptions | undefined;
      const pause = async (params: ChromeMcpOperationOptions) => {
        operation = params;
        await sleep(30_000, undefined, { signal: params.signal });
      };
      if (phase === "coordinate action") {
        chromeMcpMocks.clickChromeMcpCoords.mockImplementationOnce(pause);
      } else {
        chromeMcpMocks.evaluateChromeMcpScript.mockImplementationOnce(async (params) => {
          await pause(params);
          return "https://example.com";
        });
      }
      const handler = getActPostHandler();
      const response = createBrowserRouteResponse();
      const ctrl = new AbortController();
      clientControllers.push(ctrl);
      const reason = new Error("caller cancelled the browser action");
      const completion = Promise.resolve(
        handler?.(
          {
            params: {},
            query: {},
            body: { kind: "clickCoords", x: 20, y: 30 },
            signal: ctrl.signal,
          },
          response.res,
        ),
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(operation?.timeoutMs).toBe(60_000);
      expect(operation?.signal?.aborted).toBe(false);

      ctrl.abort(reason);
      await vi.advanceTimersByTimeAsync(0);

      expect(operation?.signal?.aborted).toBe(true);
      expect(operation?.signal?.reason).toBe(reason);
      expect(await completion).toBe(reason);
      expect(response.body).toBeUndefined();
    },
  );

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

  it("rechecks the page url after delayed navigation-triggering interactions", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce(42 as never)
      .mockResolvedValueOnce("https://example.com" as never)
      .mockResolvedValueOnce("http://169.254.169.254/latest/meta-data/" as never)
      .mockResolvedValueOnce("http://169.254.169.254/latest/meta-data/" as never);

    const response = await runAction({ kind: "evaluate", fn: "() => document.title" });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(4);
    expectNavigationProbeUrls([
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

  it("forwards evaluate timeoutMs to Chrome MCP existing-session execution", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(42 as never);

    const response = await runAction(
      { kind: "evaluate", fn: "() => 1 + 1", timeoutMs: 60_000 },
      null,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledOnce();
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({
        fn: "() => 1 + 1",
        timeoutMs: 60_000,
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

  it("fails closed when location probes never return a usable url", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never)
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce("   " as never);

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
    expectNavigationProbeUrls(["https://example.com"]);
  });

  it("fails closed when a later post-action probe becomes unreadable", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never) // action evaluate
      .mockResolvedValueOnce("https://example.com" as never) // location probe 1
      .mockResolvedValueOnce(undefined as never) // location probe 2 - unreadable
      .mockResolvedValueOnce(undefined as never) // location probe 3 - unreadable
      .mockResolvedValueOnce(undefined as never); // follow-up probe - still unreadable

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
    expectNavigationProbeUrls(["https://example.com", "https://example.com"]);
  });

  it("confirms stability via follow-up probe when URL changes on the last loop iteration", async () => {
    // Probe 1 (action evaluate result): returns the action value
    // Location probe 1 (0ms): fails (context churn)
    // Location probe 2 (250ms): reads safe URL A
    // Location probe 3 (500ms): reads safe URL B (late navigation)
    // Follow-up probe (500ms later): reads URL B again → stable, success
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never) // action evaluate result
      .mockRejectedValueOnce(new Error("context churn") as never) // location probe 1 fails
      .mockResolvedValueOnce("https://example.com" as never) // location probe 2: URL A
      .mockResolvedValueOnce("https://safe-redirect.com" as never) // location probe 3: URL B (changed)
      .mockResolvedValueOnce("https://safe-redirect.com" as never); // follow-up: URL B again → stable

    const response = await runAction({ kind: "evaluate", fn: "() => 1" });

    expect(response.statusCode).toBe(200);
    // 1 action call + 5 location probes (3 in loop + 1 failed + 1 follow-up)
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(5);
    expectNavigationProbeUrls([
      "https://example.com",
      "https://example.com",
      "https://safe-redirect.com",
      "https://safe-redirect.com",
    ]);
  });

  it("keeps probing through the full window before declaring navigation stable", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never) // action evaluate result
      .mockResolvedValueOnce("https://example.com" as never) // location probe 1
      .mockResolvedValueOnce("https://example.com" as never) // location probe 2
      .mockResolvedValueOnce("https://safe-redirect.com" as never) // location probe 3
      .mockResolvedValueOnce("https://safe-redirect.com" as never); // follow-up confirms late redirect

    const response = await runAction({ kind: "evaluate", fn: "() => 1" });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledTimes(5);
    expectNavigationProbeUrls([
      "https://example.com",
      "https://example.com",
      "https://example.com",
      "https://safe-redirect.com",
      "https://safe-redirect.com",
    ]);
  });

  it("fails closed when follow-up probe sees yet another URL change", async () => {
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never) // action evaluate result
      .mockResolvedValueOnce("https://a.com" as never) // location probe 1
      .mockResolvedValueOnce("https://b.com" as never) // location probe 2: changed
      .mockResolvedValueOnce("https://c.com" as never) // location probe 3: changed again
      .mockResolvedValueOnce("https://d.com" as never); // follow-up: still changing

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
  });

  it("fails closed when a probe error follows two stable reads", async () => {
    // Probes 1 + 2 match (sawStableAllowedUrl would be true), probe 3 throws.
    // Guard must NOT return success — the throw invalidates prior stability.
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce("result" as never) // action evaluate result
      .mockResolvedValueOnce("https://example.com" as never) // location probe 1
      .mockResolvedValueOnce("https://example.com" as never) // location probe 2 → stable pair
      .mockRejectedValueOnce(new Error("context destroyed") as never) // location probe 3 → error
      .mockRejectedValueOnce(new Error("context destroyed") as never); // follow-up → still errored

    await expectActionToReject({ kind: "evaluate", fn: "() => 1" });
    expectNavigationProbeUrls([
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
    expect(vi.mocked(resolveSafeRouteTabUrl)).toHaveBeenCalledOnce();
    expect(routeState.profileCtx.listTabs).toHaveBeenCalledOnce();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("normalizes keyboard aliases before existing-session Chrome MCP dispatch", async () => {
    const response = await runAction({ kind: "press", key: "Ctrl+Shift+Esc" }, null);

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.pressChromeMcpKey).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Control+Shift+Escape" }),
    );
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
