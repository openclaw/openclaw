import "./agent.snapshot-mocks.test-support.js";
import { setTimeout as sleep } from "node:timers/promises";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMcpOperationOptions } from "../chrome-mcp.js";
import type { ChromeMcpSnapshotNode } from "../chrome-mcp.snapshot.js";
import { browserAct } from "../client-actions.js";
import {
  expectResponse,
  expectResponseContaining,
  runRoute,
  startRoute,
  gate,
} from "./agent-route.test-support.js";
import type { BrowserDispatchRequest, BrowserDispatchResponse } from "./dispatcher.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import {
  createExistingSessionAgentSharedModule,
  createExistingSessionClientHarness,
  delayed,
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

const routeState = existingSessionRouteState;
const publicUrl = "https://example.com";
function snapshotTree(
  rootId: string,
  ...nodes: Array<[string, string, string]>
): ChromeMcpSnapshotNode {
  return {
    id: rootId,
    role: "document",
    name: "Example",
    children: nodes.map(([id, role, name]) => ({ id, role, name })),
  };
}

const mcp = vi.hoisted(() => ({
  ChromeMcpDocumentUnavailableError: class ChromeMcpDocumentUnavailableError extends Error {},
  clickChromeMcpCoords: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  clickChromeMcpElement: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  evaluateChromeMcpScript: vi.fn(
    async (
      _params: Parameters<typeof import("../chrome-mcp.js").evaluateChromeMcpScript>[0],
    ): Promise<unknown> => publicUrl,
  ),
  pressChromeMcpKey: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  fillChromeMcpElement: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  selectChromeMcpOption: vi.fn(async (_params: ChromeMcpOperationOptions) => {}),
  navigateChromeMcpPage: vi.fn(async ({ url }: { url: string }) => ({ url })),
  takeChromeMcpScreenshot: vi.fn(async (_params?: unknown) => Buffer.from("png")),
  takeChromeMcpSnapshot: vi.fn(async () => snapshotTree("root", ["btn-1", "button", "Continue"])),
  withChromeMcpDocument: vi.fn(
    async (
      _params: ChromeMcpOperationOptions,
      task: (document: { evaluate: (fn: string) => unknown }) => unknown,
    ) =>
      await task({
        evaluate: async (fn) =>
          fn.includes("return boundDocument") ? publicUrl : { kind: "result", ready: true },
      }),
  ),
}));

const {
  clickChromeMcpElement: click,
  evaluateChromeMcpScript: evaluate,
  fillChromeMcpElement: fill,
  pressChromeMcpKey: press,
  withChromeMcpDocument: withDocument,
  takeChromeMcpScreenshot: screenshotMock,
  takeChromeMcpSnapshot: snapshotMock,
} = mcp;

const transportMocks = vi.hoisted(() => ({
  dispatch: vi.fn<(request: BrowserDispatchRequest) => Promise<BrowserDispatchResponse>>(),
}));

// mock-isolation: Record local dispatch without starting the browser control service.
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

// mock-isolation: Exercise route ownership with a synthetic Chrome MCP session, never a live browser.
vi.mock("../chrome-mcp.js", () => ({
  ...mcp,
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  hoverChromeMcpElement: vi.fn(async () => {}),
  resizeChromeMcpPage: vi.fn(async () => {}),
}));

// mock-isolation: Route screenshots through the synthetic MCP target used by this suite.
vi.mock("../chrome-mcp-actions.js", () => ({
  takeChromeMcpScreenshotOnTarget: async (params: unknown) => await screenshotMock(params),
}));

vi.mock("../chrome-mcp-routing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chrome-mcp-routing.js")>()),
  resolveChromeMcpSnapshotRef: (_session: unknown, targetId: string, uid: string) => ({
    targetId,
    uid,
    documentUid: "root",
  }),
  withChromeMcpTarget: vi.fn(
    async (
      params: { profileName: string; signal?: AbortSignal; timeoutMs?: number },
      run: (target: unknown) => Promise<unknown>,
    ) =>
      await run({
        pageId: 7,
        profileOptions: {},
        session: {},
        callTool: async (
          name: string,
          args: { function: string; args: string[] },
          options: { signal?: AbortSignal; timeoutMs?: number } = params,
        ) => {
          if (name !== "evaluate_script") {
            throw new Error(`Unexpected tool ${name}`);
          }
          const value = await evaluate({
            profileName: params.profileName,
            targetId: "7",
            fn: args.function,
            args: args.args,
            signal: options.signal,
            ...options,
          });
          return { structuredContent: { message: JSON.stringify(value) } };
        },
      }),
  ),
}));

// mock-isolation: Keep CDP capture unavailable while proving existing-session routing.
vi.mock("../cdp.js", () => ({ captureScreenshot: vi.fn(), snapshotAria: vi.fn() }));

// mock-isolation: Control navigation decisions without resolving or connecting synthetic targets.
vi.mock("../navigation-guard.js", () => navigation);

vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => null),
  getLoadedPwAiModule: () => null,
}));

vi.mock("./agent.shared.js", () => createExistingSessionAgentSharedModule());

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");
const { registerBrowserAgentActHookRoutes } = await import("./agent.act.hooks.js");
const { registerBrowserAgentSnapshotRoutes } = await import("./agent.snapshot.js");
const { resolveSafeRouteTabUrl, withRouteTabContext } = await import("./agent.shared.js");

function route(kind: "snapshot" | "screenshot" | "act" | "dialog", ssrfPolicy?: unknown) {
  const { app, getHandlers, postHandlers } = createBrowserRouteApp();
  const resolved = { evaluateEnabled: true, actionTimeoutMs: 60_000, ssrfPolicy };
  const ctx = { state: () => ({ resolved }) } as never;
  const register =
    kind === "act"
      ? registerBrowserAgentActRoutes
      : kind === "dialog"
        ? registerBrowserAgentActHookRoutes
        : registerBrowserAgentSnapshotRoutes;
  register(app, ctx);
  const handler = (kind === "snapshot" ? getHandlers : postHandlers).get(
    kind === "dialog" ? "/hooks/dialog" : `/${kind}`,
  );
  return handler;
}

function invoke(
  kind: Parameters<typeof route>[0],
  input: Record<string, unknown>,
  options: { policy?: unknown; signal?: AbortSignal } = {},
) {
  return runRoute(route(kind, options.policy), {
    query: kind === "snapshot" ? input : {},
    body: kind === "snapshot" ? undefined : input,
    signal: options.signal,
  });
}

function expectUnsupported(response: Awaited<ReturnType<typeof runRoute>>, message: string) {
  expectResponseContaining(response, { error: expect.stringContaining(message) }, 501);
}

function expectLabelCleanup() {
  expect(evaluate).toHaveBeenLastCalledWith(
    expect.objectContaining({ signal: undefined, fn: expect.stringContaining("node.remove()") }),
  );
}

const existingTarget = {
  profileName: "chrome-live",
  profile: { name: "chrome-live", driver: "existing-session" },
  targetId: "7",
};
const requireRecord = createRequireRecord("object", "expected-label");

function deepSnapshot() {
  let root: ChromeMcpSnapshotNode = { id: "leaf", role: "text", name: "leaf" };
  for (let index = 0; index < 1_000; index += 1) {
    root = { id: `n${index}`, role: "generic", name: `n${index}`, children: [root] };
  }
  return root;
}

describe("existing-session browser routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    evaluate
      .mockReset()
      .mockResolvedValue(true)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(true);
  });

  it("forwards an empty select value to Chrome MCP", async () => {
    const value = "";
    const response = await invoke("act", { kind: "select", ref: "select-1", values: [value] });

    expect(response.statusCode).toBe(200);
    expect(mcp.selectChromeMcpOption).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "7", uid: "select-1", value }),
    );
  });

  it("preserves screenshot cancellation when label cleanup fails", async () => {
    const failure = new Error("label injection timed out");
    const controller = new AbortController();
    evaluate
      .mockReset()
      .mockImplementationOnce(async () => {
        controller.abort(failure);
        throw failure;
      })
      .mockRejectedValueOnce(new Error("cleanup failed"));
    const { completion } = startRoute(route("screenshot"), {
      body: { labels: true },
      signal: controller.signal,
    });
    await expect(completion).rejects.toBe(failure);
    expect(screenshotMock).not.toHaveBeenCalled();
    expectLabelCleanup();
  });

  it("joins cancelled label injection before cleaning its document", async () => {
    const controller = new AbortController();
    const failure = new Error("caller cancelled labels");
    const labels = gate<number>();
    evaluate.mockReset().mockImplementationOnce(labels.block);
    let settled = false;
    const { completion } = startRoute(route("screenshot"), {
      body: { labels: true },
      signal: controller.signal,
    });
    const request = completion.finally(() => {
      settled = true;
    });
    const rejected = expect(request).rejects.toBe(failure);
    try {
      await labels.entered;
      controller.abort(failure);
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      labels.resolve(1);
      await rejected;
    }
    expect(screenshotMock).not.toHaveBeenCalled();
    expectLabelCleanup();
    expect(evaluate).toHaveBeenLastCalledWith(expect.objectContaining({ args: ["root"] }));
  });

  it("does not publish screenshot success before label cleanup", async () => {
    const failure = new Error("cleanup failed after capture");
    evaluate.mockReset().mockResolvedValueOnce(1).mockRejectedValueOnce(failure);
    const response = createBrowserRouteResponse();
    const publish = vi.spyOn(response.res, "json");
    const completion = route("screenshot")?.(
      { params: {}, query: {}, body: { labels: true } },
      response.res,
    );
    await expect(completion).rejects.toBe(failure);
    expect(publish).not.toHaveBeenCalled();
    expect(screenshotMock).toHaveBeenCalledOnce();
  });

  it("clears snapshot labels after media persistence fails and its caller aborts", async () => {
    const failure = new Error("media persistence failed");
    const controller = new AbortController();
    vi.mocked(saveMediaBuffer).mockImplementationOnce(async () => {
      controller.abort();
      throw failure;
    });
    const response = await invoke(
      "snapshot",
      { format: "ai", labels: "1" },
      { signal: controller.signal },
    );
    expect(response.body).toEqual({ error: failure.message });
    expectLabelCleanup();
  });

  it("omits deltas for existing-session snapshots without stable document identity", async () => {
    snapshotMock
      .mockResolvedValueOnce(snapshotTree("root-1", ["save-1", "button", "Save"]))
      .mockResolvedValueOnce(
        snapshotTree("root-2", ["save-2", "button", "Save"], ["alert-2", "alert", "Required"]),
      );
    const handler = route("snapshot");
    await runRoute(handler, { query: { format: "ai" } });
    const second = await runRoute(handler, { query: { format: "ai" } });

    const body = requireRecord(second.body, "second snapshot body");
    expect(body.snapshot).not.toContain("[new]");
    expect(body.newElements).toBeUndefined();
  });

  it("labels and returns only Chrome MCP refs inside the final snapshot budget", async () => {
    snapshotMock.mockResolvedValueOnce(
      snapshotTree(
        "root",
        ["btn-1", "button", "Visible"],
        ["btn-2", "button", `Hidden ${"X".repeat(100)}`],
      ),
    );
    const firstLines = '- document "Example"\n  - button "Visible" [ref=btn-1]';
    const marker = "[...TRUNCATED - page too large]";
    const maxChars = firstLines.length + 2 + marker.length;
    const response = await invoke("snapshot", {
      format: "ai",
      labels: "1",
      maxChars: String(maxChars),
    });

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "snapshot body");
    expect(body).toMatchObject({ snapshot: `${firstLines}\n\n${marker}` });
    expect(body.refs).toEqual({ "btn-1": { role: "button", name: "Visible" } });
    expect(body.stats).toEqual({ lines: 4, chars: maxChars, refs: 1, interactive: 1 });
    const render = evaluate.mock.calls[0]?.[0];
    expect(render?.fn).toContain('"btn-1"');
    expect(render?.fn).not.toContain('"btn-2"');
  });

  it.each([
    ["snapshot", { format: "ai" }, true],
    ["snapshot", { format: "aria" }, true],
    ["snapshot", { format: "ai", depth: "5" }, undefined],
    ["screenshot", { labels: true }, true],
  ] as const)("reports depth truncation for %s %j", async (kind, input, truncated) => {
    snapshotMock.mockResolvedValueOnce(deepSnapshot());
    const response = await invoke(kind, input);
    const body = requireRecord(response.body, "snapshot body");
    expect(body.truncated).toBe(truncated);
    if (kind === "screenshot") {
      expectResponseContaining(response, { labels: true });
    } else if ("format" in input && input.format === "aria") {
      expect(body.nodes).toHaveLength(101);
    } else if (truncated) {
      expect(body.snapshot).toContain("[...TRUNCATED - accessibility tree too deep]");
    } else {
      expect(body.snapshot).not.toContain("TRUNCATED");
    }
  });

  it("keeps ref semantics for labeled existing-session screenshots", async () => {
    const response = await invoke("screenshot", {
      labels: true,
      ref: "btn-1",
      type: "jpeg",
      timeoutMs: 4321,
    });

    expectResponseContaining(response, { ok: true, labels: true });
    expect(snapshotMock).not.toHaveBeenCalled();
    expect(screenshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "btn-1", format: "jpeg", timeoutMs: 4321 }),
    );
  });

  it("routes close through profile selection state with exact call options", async () => {
    const ctrl = new AbortController();
    const response = await invoke(
      "act",
      { kind: "close", targetId: "7", timeoutMs: 4321 },
      { signal: ctrl.signal },
    );

    expect(response.statusCode).toBe(200);
    expect(routeState.profileCtx.closeTab).toHaveBeenCalledWith("7", {
      exactTargetId: true,
      signal: expect.any(AbortSignal),
      timeoutMs: 60_000,
    });
    const reason = new Error("caller cancelled");
    ctrl.abort(reason);
    expect(routeState.profileCtx.closeTab).toHaveBeenCalledWith(
      "7",
      expect.objectContaining({ signal: expect.objectContaining({ aborted: true, reason }) }),
    );
  });

  it.each([undefined, "#admin"])("rejects disallowed snapshots (selector=%s)", async (selector) => {
    const url = "http://127.0.0.1:8080/admin";
    const policy = { allowPrivateNetwork: false };
    routeState.profileCtx.ensureTabAvailable.mockResolvedValueOnce({ targetId: "7", url });
    const error = selector
      ? EXISTING_SESSION_LIMITS.snapshot.snapshotSelector
      : "browser navigation blocked by policy";
    if (!selector) {
      navigation.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(new Error(error));
    }
    expectResponse(
      await invoke("snapshot", { format: "ai", selector }, { policy }),
      { error },
      400,
    );
    expect(snapshotMock).not.toHaveBeenCalled();
    if (selector) {
      expect(navigation.assertBrowserNavigationAllowed).not.toHaveBeenCalled();
      expect(navigation.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
    } else {
      expect(navigation.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
        url,
        ssrfPolicy: policy,
      });
    }
  });

  it("checks existing-session screenshot URL when SSRF policy is configured", async () => {
    const response = await invoke(
      "screenshot",
      { ref: "btn-1", type: "jpeg" },
      { policy: { allowPrivateNetwork: false } },
    );

    expect(response.statusCode).toBe(200);
    expect(navigation.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "https://example.com",
      ssrfPolicy: { allowPrivateNetwork: false },
    });
  });

  it("rejects selector-based element screenshots for existing-session profiles", async () => {
    const response = await invoke("screenshot", { element: "#submit" });

    expect(response.statusCode).toBe(400);
    const body = requireRecord(response.body, "response body");
    expect(String(body.error)).toContain("element screenshots are not supported");
    expect(screenshotMock).not.toHaveBeenCalled();
  });

  it.each([
    ["act", { kind: "wait", loadState: "networkidle" }, "loadState=networkidle", evaluate],
    [
      "act",
      { kind: "type", ref: "input-1", text: "hello", timeoutMs: 1234 },
      "type does not support timeoutMs",
      fill,
    ],
    ["dialog", { accept: true, dialogId: "d1" }, "dialogId", evaluate],
  ] as const)(
    "rejects unsupported existing-session %s/%s before effects",
    async (routeName, body, error, effect) => {
      expectUnsupported(await runRoute(route(routeName), { body }), error);
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("explains unsupported focused paste without forwarding or echoing its text", async () => {
    const response = await invoke("act", { kind: "insertText", text: "synthetic-password-paste" });

    expectResponse(
      response,
      {
        code: "ACT_EXISTING_SESSION_UNSUPPORTED",
        error:
          "Paste is not supported for existing-session browser profiles. Use a managed browser profile.",
      },
      501,
    );
    expect(JSON.stringify(response.body)).not.toContain("synthetic-password-paste");
    expect(fill).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("supports glob URL waits for existing-session profiles", async () => {
    const probe = vi.fn(async (_fn: string) => "https://example.com/");
    withDocument.mockImplementationOnce(async (_params, task) => await task({ evaluate: probe }));

    const response = await invoke("act", { kind: "wait", url: "**/example.com/" });

    expectResponseContaining(response, { ok: true, targetId: "7" });
    const documentParams = requireRecord(withDocument.mock.calls[0]?.[0], "document params");
    expect(documentParams).toMatchObject(existingTarget);
    expect(documentParams.userDataDir).toBeUndefined();
    expect(probe).toHaveBeenCalledOnce();
    expect(String(probe.mock.calls[0]?.[0])).toContain("location.href");
  });

  it("forwards click timeoutMs to the existing-session click executor", async () => {
    const ctrl = new AbortController();
    const response = await runRoute(route("act"), {
      body: { kind: "click", ref: "btn-1", timeoutMs: 1234 },
      signal: ctrl.signal,
    });

    expect(response.statusCode).toBe(200);
    const clickParams = requireRecord(click.mock.calls[0]?.[0], "click params");
    expect(clickParams).toMatchObject(existingTarget);
    expect(clickParams.uid).toBe("btn-1");
    expect(clickParams.doubleClick).toBe(false);
    expect(clickParams.timeoutMs).toBe(1234);
    expect(clickParams.signal).toBeInstanceOf(AbortSignal);
    const reason = new Error("caller cancelled");
    ctrl.abort(reason);
    expect(clickParams.signal).toMatchObject({ aborted: true, reason });
  });

  it("supports coordinate clicks for existing-session profiles", async () => {
    const response = await invoke("act", {
      kind: "clickCoords",
      x: 25,
      y: "32",
      doubleClick: true,
    });

    expectResponseContaining(response, { ok: true, targetId: "7", url: "https://example.com" });
    const coords = requireRecord(mcp.clickChromeMcpCoords.mock.calls[0]?.[0], "click params");
    expect(coords).toMatchObject({
      ...existingTarget,
      x: 25,
      y: 32,
      doubleClick: true,
    });
    expect(coords.button).toBeUndefined();
    expect(coords.delayMs).toBeUndefined();
  });

  it.each([{ button: "right" }, { delayMs: 5 }])(
    "rejects unsupported native coordinate input %j before clicking",
    async (options) => {
      const response = await invoke("act", { kind: "clickCoords", x: 25, y: 32, ...options });
      expect(response.statusCode).toBe(501);
      expect(mcp.clickChromeMcpCoords).not.toHaveBeenCalled();
    },
  );
});

const checkNavigation = navigation.assertBrowserNavigationResultAllowed;
const evaluateAction = { kind: "evaluate", fn: "() => document.title" } as const;
const typeAndSubmit = { kind: "type", ref: "field", text: "hello", submit: true } as const;
const successfulTab = { ok: true, targetId: "7", url: publicUrl };

const DEFAULT_SSRF_POLICY = { allowPrivateNetwork: false } as const;
type Policy = typeof DEFAULT_SSRF_POLICY | null;
const GUARDED_TARGET_REFRESH_ACTIONS = [
  { kind: "hover", ref: "btn-1" },
  { kind: "scrollIntoView", ref: "btn-1" },
  { kind: "drag", startRef: "item-1", endRef: "slot-1" },
  { kind: "fill", fields: [{ ref: "input-1", value: "Ada" }] },
] as const;

const originalRoute = vi.mocked(withRouteTabContext).getMockImplementation();
if (!originalRoute) {
  throw new Error("missing existing-session route context mock");
}

function actRoute(ssrfPolicy: Policy = DEFAULT_SSRF_POLICY) {
  return route("act", ssrfPolicy ?? undefined);
}

describe("existing-session interaction navigation guard", () => {
  const {
    clientControllers,
    startClientAction,
    expectClientError,
    expectPendingThenSuccess,
    expectDeadline,
  } = createExistingSessionClientHarness(transportMocks.dispatch, actRoute, browserAct);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    routeState.tab.url = publicUrl;
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

  function setWaitReadyAfter(delayMs: number) {
    const readyAt = Date.now() + delayMs;
    withDocument.mockImplementation(async (_params, task) =>
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

  async function expectActionToThrow(body: Record<string, unknown>, message: string) {
    const { completion: pending } = startRoute(actRoute(), { body });
    void pending.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(pending).rejects.toThrow(message);
  }

  function mockProbeResults(...values: unknown[]) {
    for (const value of values) {
      if (value instanceof Error) {
        evaluate.mockRejectedValueOnce(value);
      } else {
        evaluate.mockResolvedValueOnce(value);
      }
    }
  }

  function blockMetadataUrl(message: string) {
    checkNavigation.mockImplementation(async (opts) => {
      if (opts?.url.includes("169.254.169.254")) {
        throw new Error(message);
      }
    });
  }

  function expectNavigationProbeUrls(urls: string[]) {
    expect(checkNavigation.mock.calls.map(([params]) => params?.url)).toEqual(urls);
  }

  it("keeps a default existing-session wait alive past the managed wait deadline", async () => {
    setWaitReadyAfter(30_000);
    const request = await startClientAction({ kind: "wait", text: "ready" });
    await expectPendingThenSuccess(request, 25_001, 4_999, successfulTab);
  });

  it("budgets a normalized click through navigation verification", async () => {
    click.mockImplementationOnce(delayed(40_000, undefined));
    evaluate.mockImplementation(delayed(10_000, publicUrl));
    const request = await startClientAction(
      { kind: "click", ref: "button", button: " left ", selector: " " },
      DEFAULT_SSRF_POLICY,
    );

    await expectPendingThenSuccess(request, 65_001, 5_749, successfulTab);
    expect(click).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it("lets an existing-session evaluation use its requested timeout beyond two minutes", async () => {
    evaluate.mockImplementationOnce(delayed(150_000, "evaluation complete"));
    const request = await startClientAction({
      kind: "evaluate",
      fn: "() => window.ready",
      timeoutMs: 180_000,
    });

    await expectPendingThenSuccess(request, 125_251, 24_749, {
      ok: true,
      result: "evaluation complete",
    });
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 180_000 }));
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
    evaluate.mockImplementationOnce(delayed(20_000, "evaluation complete"));
    const request = await startClientAction(evaluateAction);

    await vi.advanceTimersByTimeAsync(121_249);
    expect(preparationSteps).toEqual(["browser ready", "tab verified"]);
    await expectDeadline(
      request,
      evaluate.mock.calls[0]?.[0].signal,
      "Browser action request timed out after 121250ms",
    );
  });

  it("cancels a slow submit at the shared body deadline after filling succeeds", async () => {
    const completed: string[] = [];
    fill.mockImplementationOnce(
      delayed(45_000, undefined, () => {
        completed.push("fill");
      }),
    );
    press.mockImplementationOnce(
      delayed(45_000, undefined, () => {
        completed.push("submit");
      }),
    );
    const request = await startClientAction(typeAndSubmit);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(completed).toEqual(["fill"]);
    await expectDeadline(
      request,
      press.mock.calls[0]?.[0].signal,
      "Browser action timed out after 60000ms",
    );
    expect(completed).toEqual(["fill"]);
  });

  it("does not submit when filling completes after the body deadline before its timer runs", async () => {
    fill.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 60_001);
    });
    const request = await startClientAction(typeAndSubmit);

    expect(fill).toHaveBeenCalledOnce();
    expect(press).not.toHaveBeenCalled();
    expect(request.settled).toHaveBeenCalledOnce();
    await expectClientError(request, "Browser action timed out after 60000ms");
  });

  it.each(["post-action probes", "final URL resolution"])(
    "cancels %s at the shared navigation verification deadline",
    async (phase) => {
      const completed = vi.fn();
      let resolutionSignal: AbortSignal | undefined;
      if (phase === "post-action probes") {
        evaluate
          .mockResolvedValueOnce("evaluation complete")
          .mockImplementation(delayed(30_000, publicUrl, completed));
      } else {
        const actual =
          await vi.importActual<typeof import("./agent.shared.js")>("./agent.shared.js");
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
      }
      const request = await startClientAction(evaluateAction, DEFAULT_SSRF_POLICY);
      await vi.advanceTimersByTimeAsync(61_249);
      const completedCount = phase === "post-action probes" ? 2 : 0;
      expect(completed).toHaveBeenCalledTimes(completedCount);
      await expectDeadline(
        request,
        phase === "final URL resolution"
          ? resolutionSignal
          : evaluate.mock.calls.at(-1)?.[0].signal,
        "Browser navigation verification timed out after 61250ms",
      );
      expect(completed).toHaveBeenCalledTimes(completedCount);
    },
  );

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
    withDocument.mockImplementationOnce(delayed(1_000, false));
    const request = await startClientAction({ kind: "wait", selector: "#missing", timeoutMs: 250 });
    await vi.advanceTimersByTimeAsync(249);
    const snapshotSignal = withDocument.mock.calls[0]?.[0].signal;
    expect(snapshotSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshotSignal?.aborted).toBe(true);
    expect(snapshotSignal?.reason).toEqual(new Error("Timed out waiting for condition"));
    await expectClientError(request, "Timed out waiting for condition");
  });

  it("rejects a condition that finishes after its deadline before the timer runs", async () => {
    withDocument.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 251);
      return true;
    });
    const request = await startClientAction({ kind: "wait", selector: "#ready", timeoutMs: 250 });
    expect(request.settled).toHaveBeenCalledOnce();
    await expectClientError(request, "Timed out waiting for condition");
  });

  it("checks navigation after key-driven submit", async () => {
    const typeResponse = await runAction({ ...typeAndSubmit, ref: "field-1" });

    expect(typeResponse.statusCode).toBe(200);
    expect(press).toHaveBeenCalledWith(expect.objectContaining({ key: "Enter" }));
    expectNavigationProbeUrls(Array.from({ length: 4 }, () => publicUrl));
  });

  it("does not run a wait predicate in a document rejected by navigation policy", async () => {
    const documentEvaluate = vi.fn().mockResolvedValue("http://169.254.169.254/latest/meta-data");
    withDocument.mockImplementationOnce(async (_params, task) =>
      task({ evaluate: documentEvaluate }),
    );
    checkNavigation
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("blocked document"));

    await expectActionToThrow({ kind: "wait", fn: "() => document.cookie" }, "blocked document");

    expect(documentEvaluate).toHaveBeenCalledOnce();
    expect(String(documentEvaluate.mock.calls[0]?.[0])).not.toContain("document.cookie");
  });

  it("rechecks a requested URL after a ready predicate mutates same-document history", async () => {
    withDocument.mockImplementation(async (_params, task) => {
      let urlReads = 0;
      return await task({
        evaluate: async (fn) => {
          if (!fn.includes("return boundDocument")) {
            return { kind: "result", ready: true };
          }
          if (++urlReads === 2) {
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
    evaluate.mockImplementationOnce(async (params) => {
      operation = params;
      await sleep(30_000, undefined, { signal: params.signal });
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
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("normalizes ref-scoped statement-body evaluate sources before Chrome MCP execution", async () => {
    evaluate.mockResolvedValueOnce("Ada");

    const response = await runAction(
      { kind: "evaluate", ref: "7", fn: "const text = el.textContent; return text;" },
      null,
    );

    expect(response.statusCode).toBe(200);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith(
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
    expect(evaluate).not.toHaveBeenCalled();
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
    expect(click).toHaveBeenCalledOnce();
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
        expect(evaluate).toHaveBeenCalledTimes(5);
      } else {
        await expectActionToThrow(action, "Unable to verify stable post-interaction navigation");
      }
      if (urls) {
        expectNavigationProbeUrls(urls);
      }
    },
  );

  it("skips the guard when no SSRF policy is configured", async () => {
    const response = await runAction({ kind: "press", key: "Enter" }, null);

    expect(response.statusCode).toBe(200);
    expect(press).toHaveBeenCalledOnce();
    expect(evaluate).not.toHaveBeenCalled();
    expect(vi.mocked(resolveSafeRouteTabUrl)).toHaveBeenCalledOnce();
    expect(routeState.profileCtx.listTabs).toHaveBeenCalledOnce();
    expect(checkNavigation).not.toHaveBeenCalled();
  });

  it("still probes navigation when the interaction command throws", async () => {
    click.mockImplementationOnce(() => {
      throw new Error("stale element");
    });

    await expectActionToThrow({ kind: "click", ref: "btn-1" }, "stale element");
    expect(evaluate).toHaveBeenCalled();
    expect(checkNavigation).toHaveBeenCalled();
  });
});
