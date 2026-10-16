import { setTimeout as sleep } from "node:timers/promises";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMcpOperationOptions } from "../chrome-mcp.js";
import { browserAct } from "../client-actions.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import { startRoute } from "./agent-route.test-support.js";
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

const mcp = vi.hoisted(() => ({
  ChromeMcpDocumentUnavailableError: class ChromeMcpDocumentUnavailableError extends Error {},
  clickChromeMcpCoords: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  clickChromeMcpElement: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(
    async (_params: ChromeMcpOperationOptions): Promise<unknown> => "https://example.com",
  ),
  fillChromeMcpElement: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  selectChromeMcpOption: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  hoverChromeMcpElement: vi.fn(async () => {}),
  pressChromeMcpKey: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  withChromeMcpDocument: vi.fn(
    async (
      _params: ChromeMcpOperationOptions,
      task: (document: { evaluate: (fn: string) => unknown }) => unknown,
    ) =>
      await task({
        evaluate: async (fn) =>
          fn.includes("return boundDocument")
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

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>();
  const syntheticConfig = {
    browser: {
      defaultProfile: "chrome-live",
      profiles: { "chrome-live": { driver: "existing-session", color: "#123456" } },
    },
  };
  return {
    ...actual,
    readRuntimeConfig: () => syntheticConfig,
    loadConfig: () => syntheticConfig,
  };
});

const navigation = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(
    async (_opts?: { url: string; ssrfPolicy?: unknown }) => {},
  ),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../chrome-mcp.js", () => ({
  ...mcp,
  closeChromeMcpTab: vi.fn(async () => {}),
  resizeChromeMcpPage: vi.fn(async () => {}),
}));

vi.mock("../navigation-guard.js", () => navigation);

vi.mock("./agent.shared.js", () => createExistingSessionAgentSharedModule());

const publicUrl = "https://example.com";
const DEFAULT_SSRF_POLICY = { allowPrivateNetwork: false } as const;
type Policy = typeof DEFAULT_SSRF_POLICY | null;
const GUARDED_TARGET_REFRESH_ACTIONS = [
  { kind: "hover", ref: "btn-1" },
  { kind: "scrollIntoView", ref: "btn-1" },
  { kind: "drag", startRef: "item-1", endRef: "slot-1" },
  { kind: "fill", fields: [{ ref: "input-1", value: "Ada" }] },
] as const;

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");
const { resolveSafeRouteTabUrl, withRouteTabContext } = await import("./agent.shared.js");
const routeState = existingSessionRouteState;
const originalRoute = vi.mocked(withRouteTabContext).getMockImplementation();
if (!originalRoute) {
  throw new Error("missing existing-session route context mock");
}

function actRoute(ssrfPolicy: Policy = DEFAULT_SSRF_POLICY) {
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
    for (const fn of Object.values(mcp)) {
      if ("mockReset" in fn) {
        fn.mockReset();
      }
    }
    for (const fn of Object.values(navigation)) {
      fn.mockReset();
    }
    transportMocks.dispatch.mockReset();
    vi.mocked(resolveSafeRouteTabUrl).mockReset();
    vi.mocked(withRouteTabContext).mockReset();
    routeState.tab.url = publicUrl;
    routeState.profileCtx.closeTab.mockReset();
    routeState.profileCtx.listTabs.mockReset();
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

  async function startClientAction(body: BrowserActRequest, ssrfPolicy: Policy = null) {
    const handler = actRoute(ssrfPolicy);
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

  async function expectClientError(
    request: Awaited<ReturnType<typeof startClientAction>>,
    message: string,
  ) {
    expect(await request.completion).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining(message) }),
    });
  }

  function setWaitReadyAfter(delayMs: number) {
    const readyAt = Date.now() + delayMs;
    mcp.withChromeMcpDocument.mockImplementation(async (_params, task) =>
      task({
        evaluate: async (fn) =>
          fn.includes("return boundDocument")
            ? publicUrl
            : { kind: "result", ready: Date.now() >= readyAt },
      }),
    );
  }

  async function runAction(
    body: Record<string, unknown>,
    ssrfPolicy: Policy = DEFAULT_SSRF_POLICY,
  ) {
    const { response, completion: pending } = startRoute(actRoute(ssrfPolicy), { body });
    await vi.runAllTimersAsync();
    await pending;
    return response;
  }

  async function expectActionToReject(body: Record<string, unknown>) {
    await expectActionToThrow(body, "Unable to verify stable post-interaction navigation");
  }

  async function expectActionToThrow(body: Record<string, unknown>, message: string) {
    const { completion: pending } = startRoute(actRoute(), { body });
    void pending.catch(() => {});
    const completion = (async () => {
      await vi.runAllTimersAsync();
      await pending;
    })();

    await expect(completion).rejects.toThrow(message);
  }

  async function expectDeadline(
    request: Awaited<ReturnType<typeof startClientAction>>,
    signal: AbortSignal | undefined,
    message: string,
  ) {
    expect(signal?.aborted).toBe(false);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(request.settled).toHaveBeenCalledOnce();
    await expectClientError(request, message);
    expect(transportMocks.dispatch.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  }

  function mockProbeResults(...values: unknown[]) {
    for (const value of values) {
      if (value instanceof Error) {
        mcp.evaluateChromeMcpScript.mockRejectedValueOnce(value);
      } else {
        mcp.evaluateChromeMcpScript.mockResolvedValueOnce(value);
      }
    }
  }

  function blockMetadataUrl(message: string) {
    navigation.assertBrowserNavigationResultAllowed.mockImplementation(async (opts) => {
      if (opts?.url.includes("169.254.169.254")) {
        throw new Error(message);
      }
    });
  }

  function expectNavigationProbeUrls(urls: string[]) {
    expect(
      navigation.assertBrowserNavigationResultAllowed.mock.calls.map(([params]) => params?.url),
    ).toEqual(urls);
  }

  it("keeps a default existing-session wait alive past the managed wait deadline", async () => {
    setWaitReadyAfter(30_000);
    const request = await startClientAction({ kind: "wait", text: "ready" });

    await vi.advanceTimersByTimeAsync(25_001);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);

    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      result: { ok: true, targetId: "7", url: publicUrl },
    });
  });

  it("budgets a normalized click through navigation verification", async () => {
    mcp.clickChromeMcpElement.mockImplementationOnce(async ({ signal }) => {
      await sleep(40_000, undefined, { signal });
    });
    mcp.evaluateChromeMcpScript.mockImplementation(async ({ signal }) => {
      await sleep(10_000, undefined, { signal });
      return publicUrl;
    });
    const request = await startClientAction(
      { kind: "click", ref: "button", button: " left ", selector: " " },
      DEFAULT_SSRF_POLICY,
    );

    await vi.advanceTimersByTimeAsync(65_001);
    expect(request.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_749);

    expect(request.settled).toHaveBeenCalledOnce();
    expect(await request.completion).toMatchObject({
      result: { ok: true, targetId: "7", url: publicUrl },
    });
    expect(mcp.clickChromeMcpElement).toHaveBeenCalledOnce();
    expect(mcp.evaluateChromeMcpScript).toHaveBeenCalledTimes(3);
  });

  it("lets an existing-session evaluation use its requested timeout beyond two minutes", async () => {
    mcp.evaluateChromeMcpScript.mockImplementationOnce(async ({ signal }) => {
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
    expect(mcp.evaluateChromeMcpScript).toHaveBeenCalledWith(
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
      return await originalRoute(params);
    });
    let evaluationSignal: AbortSignal | undefined;
    mcp.evaluateChromeMcpScript.mockImplementationOnce(async ({ signal }) => {
      evaluationSignal = signal;
      await sleep(20_000, undefined, { signal });
      return "evaluation complete";
    });
    const request = await startClientAction({ kind: "evaluate", fn: "() => document.title" });

    await vi.advanceTimersByTimeAsync(121_249);
    expect(preparationSteps).toEqual(["browser ready", "tab verified"]);
    await expectDeadline(
      request,
      evaluationSignal,
      "Browser action request timed out after 121250ms",
    );
  });

  it("cancels a slow submit at the shared body deadline after filling succeeds", async () => {
    const completed: string[] = [];
    let submitSignal: AbortSignal | undefined;
    mcp.fillChromeMcpElement.mockImplementationOnce(async ({ signal }) => {
      await sleep(45_000, undefined, { signal });
      completed.push("fill");
    });
    mcp.pressChromeMcpKey.mockImplementationOnce(async ({ signal }) => {
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
    await expectDeadline(request, submitSignal, "Browser action timed out after 60000ms");
    expect(completed).toEqual(["fill"]);
  });

  it("does not submit when filling completes after the body deadline before its timer runs", async () => {
    mcp.fillChromeMcpElement.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 60_001);
    });
    const request = await startClientAction({
      kind: "type",
      ref: "field",
      text: "hello",
      submit: true,
    });

    expect(mcp.fillChromeMcpElement).toHaveBeenCalledOnce();
    expect(mcp.pressChromeMcpKey).not.toHaveBeenCalled();
    expect(request.settled).toHaveBeenCalledOnce();
    await expectClientError(request, "Browser action timed out after 60000ms");
  });

  it("bounds all post-action navigation probes by one verification deadline", async () => {
    const completedProbes: number[] = [];
    let probeSignal: AbortSignal | undefined;
    mcp.evaluateChromeMcpScript
      .mockResolvedValueOnce("evaluation complete")
      .mockImplementation(async ({ signal }) => {
        probeSignal = signal;
        await sleep(30_000, undefined, { signal });
        completedProbes.push(Date.now());
        return publicUrl;
      });
    const request = await startClientAction(
      { kind: "evaluate", fn: "() => document.title" },
      DEFAULT_SSRF_POLICY,
    );

    await vi.advanceTimersByTimeAsync(61_249);
    expect(completedProbes).toHaveLength(2);
    await expectDeadline(
      request,
      probeSignal,
      "Browser navigation verification timed out after 61250ms",
    );
    expect(completedProbes).toHaveLength(2);
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
            return [{ targetId: "7", title: "Fixture", url: publicUrl }];
          },
        },
      }),
    );
    const request = await startClientAction(
      { kind: "evaluate", fn: "() => document.title" },
      DEFAULT_SSRF_POLICY,
    );

    await vi.advanceTimersByTimeAsync(61_249);
    await expectDeadline(
      request,
      resolutionSignal,
      "Browser navigation verification timed out after 61250ms",
    );
  });

  it.each([
    ["delay exceeding call timeout", undefined, 1_000],
    ["condition after a delay", "ready", 1_250],
  ] as const)(
    "completes a healthy existing-session %s through the client transport",
    async (_name, text, durationMs) => {
      setWaitReadyAfter(durationMs);
      const request = await startClientAction(
        {
          kind: "wait",
          timeMs: 1_000,
          timeoutMs: 500,
          ...(text ? { text } : {}),
        },
        DEFAULT_SSRF_POLICY,
      );
      await vi.advanceTimersByTimeAsync(durationMs + 750);
      expect(request.settled).toHaveBeenCalledOnce();
      expect(await request.completion).toMatchObject({ result: { ok: true, targetId: "7" } });
    },
  );

  it("preserves the condition timeout while cancelling an outstanding snapshot", async () => {
    let snapshotSignal: AbortSignal | undefined;
    mcp.withChromeMcpDocument.mockImplementationOnce(async (params) => {
      snapshotSignal = params.signal;
      await sleep(1_000, undefined, { signal: params.signal });
      return false;
    });
    const request = await startClientAction({ kind: "wait", selector: "#missing", timeoutMs: 250 });
    await vi.advanceTimersByTimeAsync(249);
    expect(snapshotSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshotSignal?.aborted).toBe(true);
    expect(snapshotSignal?.reason).toEqual(new Error("Timed out waiting for condition"));
    await expectClientError(request, "Timed out waiting for condition");
  });

  it("rejects a condition that finishes after its deadline before the timer runs", async () => {
    mcp.withChromeMcpDocument.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 251);
      return true;
    });
    const request = await startClientAction({ kind: "wait", selector: "#ready", timeoutMs: 250 });
    expect(request.settled).toHaveBeenCalledOnce();
    await expectClientError(request, "Timed out waiting for condition");
  });

  it("checks navigation after key-driven submit", async () => {
    const typeResponse = await runAction({
      kind: "type",
      ref: "field-1",
      text: "hello",
      submit: true,
    });

    expect(typeResponse.statusCode).toBe(200);
    expect(mcp.pressChromeMcpKey).toHaveBeenCalledWith(expect.objectContaining({ key: "Enter" }));
    expectNavigationProbeUrls(Array.from({ length: 4 }, () => publicUrl));
  });

  it("does not run a wait predicate in a document rejected by navigation policy", async () => {
    const evaluate = vi.fn().mockResolvedValue("http://169.254.169.254/latest/meta-data");
    mcp.withChromeMcpDocument.mockImplementationOnce(
      async (_params, task) => await task({ evaluate }),
    );
    navigation.assertBrowserNavigationResultAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("blocked document"));

    await expectActionToThrow({ kind: "wait", fn: "() => document.cookie" }, "blocked document");

    expect(evaluate).toHaveBeenCalledOnce();
    expect(String(evaluate.mock.calls[0]?.[0])).not.toContain("document.cookie");
  });

  it("rechecks a requested URL after a ready predicate mutates same-document history", async () => {
    mcp.withChromeMcpDocument.mockImplementation(async (_params, task) => {
      let urlReads = 0;
      return await task({
        evaluate: async (fn) => {
          if (!fn.includes("return boundDocument")) {
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

  it("propagates caller cancellation during navigation verification without changing the MCP call timeout", async () => {
    let operation: ChromeMcpOperationOptions | undefined;
    const pause = async (params: ChromeMcpOperationOptions) => {
      operation = params;
      await sleep(30_000, undefined, { signal: params.signal });
    };
    mcp.evaluateChromeMcpScript.mockImplementationOnce(async (params) => {
      await pause(params);
      return publicUrl;
    });
    const ctrl = new AbortController();
    clientControllers.push(ctrl);
    const reason = new Error("caller cancelled the browser action");
    const { response, completion: pending } = startRoute(actRoute(), {
      body: { kind: "clickCoords", x: 20, y: 30 },
      signal: ctrl.signal,
    });
    const completion = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(operation?.timeoutMs).toBe(60_000);
    expect(operation?.signal?.aborted).toBe(false);

    ctrl.abort(reason);
    await vi.advanceTimersByTimeAsync(0);

    expect(operation?.signal?.aborted).toBe(true);
    expect(operation?.signal?.reason).toBe(reason);
    expect(await completion).toBe(reason);
    expect(response.body).toBeUndefined();
  });

  it("cancels a pending existing-session wait when its request aborts", async () => {
    const ctrl = new AbortController();
    const pending = actRoute(null)?.(
      { params: {}, query: {}, body: { kind: "wait", timeMs: 30_000 }, signal: ctrl.signal },
      createBrowserRouteResponse().res,
    );
    void pending?.catch(() => {});

    ctrl.abort(new Error("request cancelled after browser crash"));

    await expect(pending).rejects.toThrow(/aborted|cancelled/i);
    expect(mcp.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("normalizes ref-scoped statement-body evaluate sources before Chrome MCP execution", async () => {
    mcp.evaluateChromeMcpScript.mockResolvedValueOnce("Ada" as never);

    const response = await runAction(
      { kind: "evaluate", ref: "7", fn: "const text = el.textContent; return text;" },
      null,
    );

    expect(response.statusCode).toBe(200);
    expect(mcp.evaluateChromeMcpScript).toHaveBeenCalledOnce();
    expect(mcp.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["7"],
        fn: "async (el) => {\nconst text = el.textContent; return text;\n}",
      }),
    );
  });

  it("blocks evaluate before execution when the current tab URL is disallowed", async () => {
    routeState.tab.url = "http://169.254.169.254/latest/meta-data/";
    blockMetadataUrl("blocked current tab");

    await expectActionToThrow(
      { kind: "evaluate", fn: "() => document.body.innerText" },
      "blocked current tab",
    );
    expect(mcp.evaluateChromeMcpScript).not.toHaveBeenCalled();
    expectNavigationProbeUrls(["http://169.254.169.254/latest/meta-data/"]);
  });

  it("fails closed when a newly opened tab URL is blocked", async () => {
    routeState.profileCtx.listTabs
      .mockResolvedValueOnce([routeState.tab])
      .mockResolvedValueOnce([
        routeState.tab,
        { targetId: "9", url: "http://169.254.169.254/latest/meta-data/" },
      ]);
    blockMetadataUrl("blocked new tab");

    await expectActionToThrow({ kind: "click", ref: "btn-1" }, "blocked new tab");
    expect(mcp.clickChromeMcpElement).toHaveBeenCalledOnce();
  });

  const redirect = "https://safe-redirect.com";
  const probeError = new Error("context destroyed");
  it.each([
    ["unusable locations", ["result", undefined, null, "   "], [publicUrl], false],
    [
      "late stable redirect",
      ["result", publicUrl, publicUrl, redirect, redirect],
      [publicUrl, publicUrl, publicUrl, redirect, redirect],
      true,
    ],
    [
      "ongoing URL changes",
      ["result", "https://a.com", "https://b.com", "https://c.com", "https://d.com"],
      undefined,
      false,
    ],
    [
      "late probe errors",
      ["result", publicUrl, publicUrl, probeError, probeError],
      [publicUrl, publicUrl, publicUrl],
      false,
    ],
  ] satisfies Array<[string, unknown[], string[] | undefined, boolean]>)(
    "verifies post-action navigation: %s",
    async (_name, values, urls, ok) => {
      mockProbeResults(...values);
      const action = { kind: "evaluate", fn: "() => 1" };
      if (ok) {
        expect((await runAction(action)).statusCode).toBe(200);
        expect(mcp.evaluateChromeMcpScript).toHaveBeenCalledTimes(5);
      } else {
        await expectActionToReject(action);
      }
      if (urls) {
        expectNavigationProbeUrls(urls);
      }
    },
  );

  it("skips the guard when no SSRF policy is configured", async () => {
    const response = await runAction({ kind: "press", key: "Enter" }, null);

    expect(response.statusCode).toBe(200);
    expect(mcp.pressChromeMcpKey).toHaveBeenCalledOnce();
    expect(mcp.evaluateChromeMcpScript).not.toHaveBeenCalled();
    expect(vi.mocked(resolveSafeRouteTabUrl)).toHaveBeenCalledOnce();
    expect(routeState.profileCtx.listTabs).toHaveBeenCalledOnce();
    expect(navigation.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("still probes navigation when the interaction command throws", async () => {
    mcp.clickChromeMcpElement.mockImplementationOnce(() => {
      throw new Error("stale element");
    });

    await expectActionToThrow({ kind: "click", ref: "btn-1" }, "stale element");
    expect(mcp.evaluateChromeMcpScript).toHaveBeenCalled();
    expect(navigation.assertBrowserNavigationResultAllowed).toHaveBeenCalled();
  });
});
