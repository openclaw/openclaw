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

function expectLabelCleanup() {
  expect(evaluate).toHaveBeenLastCalledWith(
    expect.objectContaining({ signal: undefined, fn: expect.stringContaining("node.remove()") }),
  );
}

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

  function labeledScreenshot(signal?: AbortSignal) {
    return startRoute(route("screenshot", DEFAULT_SSRF_POLICY), {
      body: { labels: true, ref: "btn-1", type: "jpeg", timeoutMs: 4321 },
      signal,
    });
  }

  it.each(["completed", "failed"])(
    "joins %s label injection before failed cleanup",
    async (outcome) => {
      const controller = new AbortController();
      const failure = new Error("caller cancelled labels");
      const labels = gate<number>();
      evaluate
        .mockReset()
        .mockImplementationOnce(async () => {
          const count = await labels.block();
          if (outcome === "failed") {
            throw failure;
          }
          return count;
        })
        .mockRejectedValueOnce(new Error("cleanup failed"));
      const settled = vi.fn();
      const request = labeledScreenshot(controller.signal).completion.finally(settled);
      const rejected = expect(request).rejects.toBe(failure);
      try {
        await labels.entered;
        controller.abort(failure);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
      } finally {
        labels.resolve(1);
        await rejected;
      }
      expect(screenshotMock).not.toHaveBeenCalled();
      expectLabelCleanup();
      expect(evaluate).toHaveBeenLastCalledWith(expect.objectContaining({ args: ["root"] }));
    },
  );

  it("does not publish screenshot success before label cleanup", async () => {
    const failure = new Error("cleanup failed after capture");
    evaluate.mockReset().mockResolvedValueOnce(1).mockRejectedValueOnce(failure);
    const { response, completion } = labeledScreenshot();
    const publish = vi.spyOn(response.res, "json");
    await expect(completion).rejects.toBe(failure);
    expect(publish).not.toHaveBeenCalled();
    expect(snapshotMock).not.toHaveBeenCalled();
    expect(screenshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "btn-1", format: "jpeg", timeoutMs: 4321 }),
    );
    expect(checkNavigation).toHaveBeenCalledWith({
      url: publicUrl,
      ssrfPolicy: DEFAULT_SSRF_POLICY,
    });
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
    const body = requireRecord(
      (await runRoute(handler, { query: { format: "ai" } })).body,
      "snapshot",
    );
    expect(body.snapshot).not.toContain("[new]");
    expect(body.newElements).toBeUndefined();
  });

  it("labels only refs inside the final snapshot budget", async () => {
    snapshotMock.mockResolvedValueOnce(
      snapshotTree(
        "root",
        ["btn-1", "button", "Visible"],
        ["btn-2", "button", "Hidden " + "X".repeat(100)],
      ),
    );
    const firstLines = '- document "Example"\n  - button "Visible" [ref=btn-1]';
    const marker = "[...TRUNCATED - page too large]";
    const response = await invoke("snapshot", {
      format: "ai",
      labels: "1",
      maxChars: String(firstLines.length + 2 + marker.length),
    });
    expectResponseContaining(response, { snapshot: firstLines + "\n\n" + marker });
    expect(requireRecord(response.body, "snapshot").refs).toEqual({
      "btn-1": { role: "button", name: "Visible" },
    });
    const script = evaluate.mock.calls[0]?.[0].fn;
    expect(script).toContain('"btn-1"');
    expect(script).not.toContain('"btn-2"');
  });

  it.each([
    ["snapshot", { format: "ai", depth: "5" }, undefined],
    ["screenshot", { labels: true }, true],
  ] as const)("propagates depth limits for %s", async (kind, input, truncated) => {
    snapshotMock.mockResolvedValueOnce(deepSnapshot());
    const response = await invoke(kind, input);
    expect(requireRecord(response.body, "snapshot").truncated).toBe(truncated);
    if (kind === "screenshot") {
      expectResponseContaining(response, { labels: true });
    } else {
      expect(requireRecord(response.body, "snapshot").snapshot).not.toContain("TRUNCATED");
    }
  });

  it.each([
    [
      "click",
      click,
      { kind: "click", ref: "btn-1", timeoutMs: 1234 },
      { uid: "btn-1", doubleClick: false, timeoutMs: 1234 },
    ],
    [
      "close",
      routeState.profileCtx.closeTab,
      { kind: "close", targetId: "7", timeoutMs: 4321 },
      { exactTargetId: true, timeoutMs: 60_000 },
    ],
  ] as const)(
    "forwards %s options and caller cancellation",
    async (kind, executor, body, options) => {
      const controller = new AbortController();
      expect((await invoke("act", body, { signal: controller.signal })).statusCode).toBe(200);
      const expected = { ...options, signal: expect.any(AbortSignal) };
      const args = (params: object) =>
        kind === "close" ? ["7", params] : [expect.objectContaining(params)];
      expect(executor).toHaveBeenCalledWith(...args(expected));
      const reason = new Error("caller cancelled");
      controller.abort(reason);
      expect(executor).toHaveBeenCalledWith(
        ...args({ ...options, signal: expect.objectContaining({ aborted: true, reason }) }),
      );
    },
  );

  it("rejects a snapshot URL before capture when policy denies it", async () => {
    const url = "http://127.0.0.1:8080/admin";
    routeState.profileCtx.ensureTabAvailable.mockResolvedValueOnce({ targetId: "7", url });
    checkNavigation.mockRejectedValueOnce(new Error("browser navigation blocked by policy"));
    expectResponse(
      await invoke("snapshot", { format: "ai" }, { policy: DEFAULT_SSRF_POLICY }),
      { error: "browser navigation blocked by policy" },
      400,
    );
    expect(snapshotMock).not.toHaveBeenCalled();
    expect(checkNavigation).toHaveBeenCalledWith({ url, ssrfPolicy: DEFAULT_SSRF_POLICY });
  });

  it.each([
    ["snapshot", { format: "ai", selector: "#admin" }, 400, "selector/frame", snapshotMock],
    ["screenshot", { element: "#submit" }, 400, "element screenshots", screenshotMock],
    ["act", { kind: "wait", loadState: "networkidle" }, 501, "loadState=networkidle", evaluate],
    [
      "act",
      { kind: "type", ref: "input-1", text: "hello", timeoutMs: 1234 },
      501,
      "type does not support timeoutMs",
      fill,
    ],
    ["dialog", { accept: true, dialogId: "d1" }, 501, "dialogId", evaluate],
    [
      "act",
      { kind: "clickCoords", x: 25, y: 32, button: "right" },
      501,
      "left-click",
      mcp.clickChromeMcpCoords,
    ],
    [
      "act",
      { kind: "clickCoords", x: 25, y: 32, delayMs: 5 },
      501,
      "delayMs",
      mcp.clickChromeMcpCoords,
    ],
  ] as const)(
    "rejects unsupported %s/%j before effects",
    async (kind, body, status, error, effect) => {
      expectResponseContaining(
        await invoke(kind, body, kind === "snapshot" ? { policy: DEFAULT_SSRF_POLICY } : {}),
        { error: expect.stringContaining(error) },
        status,
      );
      expect(effect).not.toHaveBeenCalled();
      expect(navigation.assertBrowserNavigationAllowed).not.toHaveBeenCalled();
      expect(checkNavigation).not.toHaveBeenCalled();
    },
  );

  it("rejects focused paste without forwarding or echoing its text", async () => {
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

  it("supports glob URL waits", async () => {
    withDocument.mockImplementationOnce(async (_params, task) =>
      task({ evaluate: async () => "https://example.com/" }),
    );
    expectResponseContaining(await invoke("act", { kind: "wait", url: "**/example.com/" }), {
      ok: true,
      targetId: "7",
    });
  });
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
    const filled = vi.fn();
    const submitted = vi.fn();
    fill.mockImplementationOnce(delayed(45_000, undefined, filled));
    press.mockImplementationOnce(delayed(45_000, undefined, submitted));
    const request = await startClientAction(typeAndSubmit);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(filled).toHaveBeenCalledOnce();
    expect(submitted).not.toHaveBeenCalled();
    await expectDeadline(
      request,
      press.mock.calls[0]?.[0].signal,
      "Browser action timed out after 60000ms",
    );
    expect(submitted).not.toHaveBeenCalled();
  });

  it("does not submit when filling completes after the body deadline before its timer runs", async () => {
    fill.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 60_001);
    });
    const request = await startClientAction(typeAndSubmit);

    expect(press).not.toHaveBeenCalled();
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
    await expectClientError(request, "Timed out waiting for condition");
  });

  it("checks navigation after key-driven submit", async () => {
    evaluate.mockResolvedValue("https://example.com/submitted");
    const typeResponse = await runAction({ ...typeAndSubmit, ref: "field-1" });
    expect(typeResponse.statusCode).toBe(200);
    expect(press).toHaveBeenCalledWith(expect.objectContaining({ key: "Enter" }));
    expect(checkNavigation).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/submitted" }),
    );
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

      expectResponseContaining(response, {
        ok: true,
        targetId: routeState.tab.targetId,
        url: routeState.tab.url,
      });
    },
  );

  it("propagates caller cancellation during navigation verification without changing the MCP call timeout", async () => {
    evaluate.mockImplementationOnce(delayed(30_000, publicUrl));
    const ctrl = new AbortController();
    clientControllers.push(ctrl);
    const reason = new Error("caller cancelled the browser action");
    const { response, completion: pending } = startRoute(actRoute(), {
      body: { kind: "clickCoords", x: 20, y: 30 },
      signal: ctrl.signal,
    });
    const completion = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const operation = evaluate.mock.calls[0]?.[0];
    expect(operation?.timeoutMs).toBe(60_000);
    expect(operation?.signal?.aborted).toBe(false);

    ctrl.abort(reason);
    await vi.advanceTimersByTimeAsync(0);

    expect(operation?.signal).toMatchObject({ aborted: true, reason });
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

  it("blocks evaluate before execution when the current tab URL is disallowed", async () => {
    routeState.tab.url = "http://169.254.169.254/latest/meta-data/";
    blockMetadataUrl("blocked current tab");

    await expectActionToThrow(
      { kind: "evaluate", fn: "() => document.body.innerText" },
      "blocked current tab",
    );
    expect(evaluate).not.toHaveBeenCalled();
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
  it.each([
    ["unusable locations", [undefined, null, "   "], false],
    ["late stable redirect", [publicUrl, publicUrl, redirect, redirect], true],
    [
      "ongoing URL changes",
      ["https://a.com", "https://b.com", "https://c.com", "https://d.com"],
      false,
    ],
    [
      "late probe errors",
      [publicUrl, publicUrl, new Error("context destroyed"), new Error("context destroyed")],
      false,
    ],
  ] satisfies Array<[string, unknown[], boolean]>)(
    "verifies post-action navigation: %s",
    async (_name, values, ok) => {
      mockProbeResults("result", ...values);
      const action = { kind: "evaluate", fn: "() => 1" };
      if (ok) {
        expect((await runAction(action)).statusCode).toBe(200);
      } else {
        await expectActionToThrow(action, "Unable to verify stable post-interaction navigation");
      }
    },
  );

  it("skips the guard when no SSRF policy is configured", async () => {
    const response = await runAction({ kind: "press", key: "Enter" }, null);

    expect(response.statusCode).toBe(200);
    expect(press).toHaveBeenCalledOnce();
    expect(evaluate).not.toHaveBeenCalled();
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
