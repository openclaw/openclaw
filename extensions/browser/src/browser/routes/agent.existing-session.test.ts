import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withChromeMcpTarget } from "../chrome-mcp-routing.js";
import type { ChromeMcpSnapshotNode } from "../chrome-mcp.snapshot.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import {
  createExistingSessionAgentSharedModule,
  existingSessionRouteState,
} from "./existing-session.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const routeState = existingSessionRouteState;

const chromeMcpMocks = vi.hoisted(() => ({
  ChromeMcpDocumentUnavailableError: class ChromeMcpDocumentUnavailableError extends Error {},
  clickChromeMcpCoords: vi.fn(async (_params: unknown) => {}),
  clickChromeMcpElement: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(
    async (_params: {
      profileName: string;
      targetId: string;
      fn: string;
      args?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    }): Promise<unknown> => true,
  ),
  fillChromeMcpElement: vi.fn(async () => {}),
  selectChromeMcpOption: vi.fn(async () => {}),
  navigateChromeMcpPage: vi.fn(async ({ url }: { url: string }) => ({ url })),
  takeChromeMcpScreenshot: vi.fn(async (_params?: unknown) => Buffer.from("png")),
  takeChromeMcpSnapshot: vi.fn<() => Promise<ChromeMcpSnapshotNode>>(async () => ({
    id: "root",
    role: "document",
    name: "Example",
    children: [{ id: "btn-1", role: "button", name: "Continue" }],
  })),
  withChromeMcpDocument: vi.fn(
    async (_params: unknown, task: (document: { evaluate: (fn: string) => unknown }) => unknown) =>
      await task({ evaluate: async () => "https://example.com/" }),
  ),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../chrome-mcp.js", () => ({
  ...chromeMcpMocks,
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  hoverChromeMcpElement: vi.fn(async () => {}),
  pressChromeMcpKey: vi.fn(async () => {}),
  resizeChromeMcpPage: vi.fn(async () => {}),
}));

vi.mock("../chrome-mcp-actions.js", () => ({
  takeChromeMcpScreenshotOnTarget: async (params: unknown) =>
    await chromeMcpMocks.takeChromeMcpScreenshot(params),
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
          const value = await chromeMcpMocks.evaluateChromeMcpScript({
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

vi.mock("../cdp.js", () => ({
  captureScreenshot: vi.fn(),
  snapshotAria: vi.fn(),
}));

vi.mock("../navigation-guard.js", () => navigationGuardMocks);

vi.mock("../screenshot.js", () => ({
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 128,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 64,
  normalizeBrowserScreenshot: vi.fn(async (buffer: Buffer) => ({
    buffer,
    sourceDimensions: null,
    contentType: "image/png",
  })),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  ensureMediaDir: vi.fn(async () => {}),
  saveMediaBuffer: vi.fn(async () => ({ path: "/tmp/fake.png" })),
}));

vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => null),
  getLoadedPwAiModule: () => null,
}));

vi.mock("./agent.shared.js", () => createExistingSessionAgentSharedModule());

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");
const { registerBrowserAgentActHookRoutes } = await import("./agent.act.hooks.js");
const { registerBrowserAgentSnapshotRoutes } = await import("./agent.snapshot.js");

function route(kind: "snapshot" | "screenshot" | "act" | "dialog", ssrfPolicy?: unknown) {
  const { app, getHandlers, postHandlers } = createBrowserRouteApp();
  const resolved =
    kind === "act" ? { evaluateEnabled: true } : kind === "dialog" ? {} : { ssrfPolicy };
  const ctx = { state: () => ({ resolved }) } as never;
  if (kind === "act") {
    registerBrowserAgentActRoutes(app, ctx);
  } else if (kind === "dialog") {
    registerBrowserAgentActHookRoutes(app, ctx);
  } else {
    registerBrowserAgentSnapshotRoutes(app, ctx);
  }
  const handler = (kind === "snapshot" ? getHandlers : postHandlers).get(
    kind === "dialog" ? "/hooks/dialog" : `/${kind}`,
  );
  expect(handler).toBeTypeOf("function");
  return handler;
}

function startRoute(handler: ReturnType<typeof route>, request: Partial<BrowserRequest>) {
  if (!handler) {
    throw new Error("Missing browser route");
  }
  const response = createBrowserRouteResponse();
  const completion = Promise.resolve(handler({ params: {}, query: {}, ...request }, response.res));
  return { response, completion };
}

async function runRoute(handler: ReturnType<typeof route>, request: Partial<BrowserRequest>) {
  const { response, completion } = startRoute(handler, request);
  await completion;
  return response;
}

function act(body: BrowserRequest["body"]) {
  return runRoute(route("act"), { body });
}

function expectUnsupported(response: Awaited<ReturnType<typeof runRoute>>, message: string) {
  expect(response.statusCode).toBe(501);
  expect(String(requireRecord(response.body, "response body").error)).toContain(message);
}

function expectLabelCleanup() {
  expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenLastCalledWith(
    expect.objectContaining({ signal: undefined, fn: expect.stringContaining("node.remove()") }),
  );
}

const requireRecord = createRequireRecord("object", "expected-label");

const existingProfile = { name: "chrome-live", driver: "existing-session" };

function deepSnapshot() {
  let root: ChromeMcpSnapshotNode = { id: "leaf", role: "text", name: "leaf" };
  for (let index = 0; index < 1_000; index += 1) {
    root = { id: `n${index}`, role: "generic", name: `n${index}`, children: [root] };
  }
  return root;
}

describe("existing-session browser routes", () => {
  beforeEach(() => {
    for (const mock of [
      routeState.profileCtx.closeTab,
      routeState.profileCtx.ensureTabAvailable,
      routeState.profileCtx.listTabs,
      vi.mocked(withChromeMcpTarget),
      ...Object.values(chromeMcpMocks),
      ...Object.values(navigationGuardMocks),
    ]) {
      if ("mockClear" in mock) {
        mock.mockClear();
      }
    }
    chromeMcpMocks.evaluateChromeMcpScript
      .mockReset()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(true);
  });

  it("forwards an empty select value to Chrome MCP", async () => {
    const value = "";
    const response = await act({ kind: "select", ref: "select-1", values: [value] });

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.selectChromeMcpOption).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "7", uid: "select-1", value }),
    );
  });

  it("preserves screenshot cancellation when label cleanup fails", async () => {
    const failure = new Error("label injection timed out");
    const controller = new AbortController();
    chromeMcpMocks.evaluateChromeMcpScript
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
    expect(chromeMcpMocks.takeChromeMcpScreenshot).not.toHaveBeenCalled();
    expectLabelCleanup();
  });

  it("joins cancelled label injection before cleaning its document", async () => {
    const controller = new AbortController();
    const failure = new Error("caller cancelled labels");
    const entered = createDeferred<void>();
    const complete = createDeferred<number>();
    chromeMcpMocks.evaluateChromeMcpScript.mockReset().mockImplementationOnce(async () => {
      entered.resolve();
      return await complete.promise;
    });
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
      await entered.promise;
      controller.abort(failure);
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      complete.resolve(1);
      await rejected;
    }
    expect(chromeMcpMocks.takeChromeMcpScreenshot).not.toHaveBeenCalled();
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: ["root"],
        signal: undefined,
        fn: expect.stringContaining("node.remove()"),
      }),
    );
  });

  it("does not publish screenshot success before label cleanup", async () => {
    const failure = new Error("cleanup failed after capture");
    chromeMcpMocks.evaluateChromeMcpScript
      .mockReset()
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(failure);
    const response = createBrowserRouteResponse();
    const publish = vi.spyOn(response.res, "json");
    const completion = route("screenshot")?.(
      { params: {}, query: {}, body: { labels: true } },
      response.res,
    );
    await expect(completion).rejects.toBe(failure);
    expect(publish).not.toHaveBeenCalled();
    expect(chromeMcpMocks.takeChromeMcpScreenshot).toHaveBeenCalledOnce();
  });

  it("clears snapshot labels after media persistence fails and its caller aborts", async () => {
    const failure = new Error("media persistence failed");
    const controller = new AbortController();
    vi.mocked(saveMediaBuffer).mockImplementationOnce(async () => {
      controller.abort();
      throw failure;
    });
    const response = await runRoute(route("snapshot"), {
      query: { format: "ai", labels: "1" },
      signal: controller.signal,
    });
    expect(response.body).toEqual({ error: failure.message });
    expectLabelCleanup();
  });

  it("omits deltas for existing-session snapshots without stable document identity", async () => {
    chromeMcpMocks.takeChromeMcpSnapshot
      .mockResolvedValueOnce({
        id: "root-1",
        role: "document",
        name: "Example",
        children: [{ id: "save-1", role: "button", name: "Save" }],
      })
      .mockResolvedValueOnce({
        id: "root-2",
        role: "document",
        name: "Example",
        children: [
          { id: "save-2", role: "button", name: "Save" },
          { id: "alert-2", role: "alert", name: "Required" },
        ],
      });
    const handler = getSnapshotGetHandler();
    await runRoute(handler, { query: { format: "ai" } });
    const second = await runRoute(handler, { query: { format: "ai" } });

    const body = requireRecord(second.body, "second snapshot body");
    expect(body.snapshot).not.toContain("[new]");
    expect(body.newElements).toBeUndefined();
  });

  it("labels and returns only Chrome MCP refs inside the final snapshot budget", async () => {
    chromeMcpMocks.takeChromeMcpSnapshot.mockResolvedValueOnce({
      id: "root",
      role: "document",
      name: "Example",
      children: [
        { id: "btn-1", role: "button", name: "Visible" },
        { id: "btn-2", role: "button", name: `Hidden ${"X".repeat(100)}` },
      ],
    });
    const firstLines = '- document "Example"\n  - button "Visible" [ref=btn-1]';
    const marker = "[...TRUNCATED - page too large]";
    const maxChars = firstLines.length + 2 + marker.length;
    const response = await runRoute(route("snapshot"), {
      query: { format: "ai", labels: "1", maxChars: String(maxChars) },
    });

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.snapshot).toBe(`${firstLines}\n\n${marker}`);
    expect(body.refs).toEqual({ "btn-1": { role: "button", name: "Visible" } });
    expect(body.stats).toEqual({
      lines: 4,
      chars: maxChars,
      refs: 1,
      interactive: 1,
    });
    const renderParams = requireRecord(
      chromeMcpMocks.evaluateChromeMcpScript.mock.calls[0]?.[0],
      "label params",
    );
    expect(renderParams.fn).toContain('"btn-1"');
    expect(renderParams.fn).not.toContain('"btn-2"');
  });

  it("reports automatic Chrome MCP depth truncation through AI and ARIA routes", async () => {
    const root = deepSnapshot();
    chromeMcpMocks.takeChromeMcpSnapshot
      .mockResolvedValueOnce(root)
      .mockResolvedValueOnce(root)
      .mockResolvedValueOnce(root);
    const handler = route("snapshot");

    const ai = await runRoute(handler, { query: { format: "ai" } });
    const aiBody = requireRecord(ai.body, "AI snapshot body");
    expect(aiBody.truncated).toBe(true);
    expect(aiBody.snapshot).toContain("[...TRUNCATED - accessibility tree too deep]");

    const aria = await runRoute(handler, { query: { format: "aria" } });
    const ariaBody = requireRecord(aria.body, "ARIA snapshot body");
    expect(ariaBody.truncated).toBe(true);
    expect(ariaBody.nodes).toHaveLength(101);

    const requestedDepth = await runRoute(handler, { query: { format: "ai", depth: "5" } });
    const requestedDepthBody = requireRecord(requestedDepth.body, "requested-depth snapshot body");
    expect(requestedDepthBody.truncated).toBeUndefined();
    expect(requestedDepthBody.snapshot).not.toContain("TRUNCATED");
  });

  it("reports automatic Chrome MCP depth truncation on labeled screenshots", async () => {
    const root = deepSnapshot();
    chromeMcpMocks.takeChromeMcpSnapshot.mockResolvedValueOnce(root);
    const response = await runRoute(route("screenshot"), { body: { labels: true } });

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "labeled screenshot body");
    expect(body.labels).toBe(true);
    expect(body.truncated).toBe(true);
  });

  it("keeps ref semantics for labeled existing-session screenshots", async () => {
    const response = await runRoute(route("screenshot"), {
      body: { labels: true, ref: "btn-1", type: "jpeg", timeoutMs: 4321 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, labels: true });
    expect(chromeMcpMocks.takeChromeMcpSnapshot).not.toHaveBeenCalled();
    expect(chromeMcpMocks.takeChromeMcpScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "btn-1", format: "jpeg", timeoutMs: 4321 }),
    );
  });

  it("routes close through profile selection state with exact call options", async () => {
    const ctrl = new AbortController();
    const response = await runRoute(route("act"), {
      body: { kind: "close", targetId: "7", timeoutMs: 4321 },
      signal: ctrl.signal,
    });

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

  it("blocks existing-session snapshots when the current URL violates browser navigation policy", async () => {
    routeState.profileCtx.ensureTabAvailable.mockResolvedValueOnce({
      targetId: "7",
      url: "http://127.0.0.1:8080/admin",
    });
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      new Error("browser navigation blocked by policy"),
    );
    const response = await runRoute(route("snapshot", { allowPrivateNetwork: false }), {
      query: { format: "ai" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "browser navigation blocked by policy" });
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8080/admin",
      ssrfPolicy: { allowPrivateNetwork: false },
    });
    expect(chromeMcpMocks.takeChromeMcpSnapshot).not.toHaveBeenCalled();
  });

  it("rejects existing-session snapshot selectors before checking the current URL", async () => {
    routeState.profileCtx.ensureTabAvailable.mockResolvedValueOnce({
      targetId: "7",
      url: "http://127.0.0.1:8080/admin",
    });
    const response = await runRoute(route("snapshot", { allowPrivateNetwork: false }), {
      query: { format: "ai", selector: "#admin" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: EXISTING_SESSION_LIMITS.snapshot.snapshotSelector,
    });
    expect(navigationGuardMocks.assertBrowserNavigationAllowed).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
    expect(chromeMcpMocks.takeChromeMcpSnapshot).not.toHaveBeenCalled();
  });

  it("checks existing-session screenshot URL when SSRF policy is configured", async () => {
    const response = await runRoute(route("screenshot", { allowPrivateNetwork: false }), {
      body: { ref: "btn-1", type: "jpeg" },
    });

    expect(response.statusCode).toBe(200);
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "https://example.com",
      ssrfPolicy: { allowPrivateNetwork: false },
    });
  });

  it("rejects selector-based element screenshots for existing-session profiles", async () => {
    const response = await runRoute(route("screenshot"), {
      body: { element: "#submit" },
    });

    expect(response.statusCode).toBe(400);
    const body = requireRecord(response.body, "response body");
    expect(String(body.error)).toContain("element screenshots are not supported");
    expect(chromeMcpMocks.takeChromeMcpScreenshot).not.toHaveBeenCalled();
  });

  it("fails closed for existing-session networkidle waits", async () => {
    const response = await act({ kind: "wait", loadState: "networkidle" });

    expectUnsupported(response, "loadState=networkidle");
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("fails closed for existing-session type timeout overrides", async () => {
    const response = await act({ kind: "type", ref: "input-1", text: "hello", timeoutMs: 1234 });

    expectUnsupported(response, "type does not support timeoutMs");
    expect(chromeMcpMocks.fillChromeMcpElement).not.toHaveBeenCalled();
  });

  it("explains unsupported focused paste without forwarding or echoing its text", async () => {
    const response = await act({ kind: "insertText", text: "synthetic-password-paste" });

    expect(response.statusCode).toBe(501);
    expect(response.body).toEqual({
      code: "ACT_EXISTING_SESSION_UNSUPPORTED",
      error:
        "Paste is not supported for existing-session browser profiles. Use a managed browser profile.",
    });
    expect(JSON.stringify(response.body)).not.toContain("synthetic-password-paste");
    expect(chromeMcpMocks.fillChromeMcpElement).not.toHaveBeenCalled();
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("fails closed for existing-session dialogId responses", async () => {
    const response = await runRoute(route("dialog"), {
      body: { accept: true, dialogId: "d1" },
    });

    expectUnsupported(response, "dialogId");
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("supports glob URL waits for existing-session profiles", async () => {
    const evaluate = vi.fn(async (_fn: string) => "https://example.com/");
    chromeMcpMocks.withChromeMcpDocument.mockImplementationOnce(
      async (_params, task) => await task({ evaluate }),
    );

    const response = await act({ kind: "wait", url: "**/example.com/" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7" });
    const documentParams = requireRecord(
      chromeMcpMocks.withChromeMcpDocument.mock.calls[0]?.[0],
      "document params",
    );
    expect(documentParams).toMatchObject({
      profileName: "chrome-live",
      profile: existingProfile,
      targetId: "7",
    });
    expect(documentParams.userDataDir).toBeUndefined();
    expect(evaluate).toHaveBeenCalledOnce();
    expect(String(evaluate.mock.calls[0]?.[0])).toContain("location.href");
  });

  it("forwards click timeoutMs to the existing-session click executor", async () => {
    const ctrl = new AbortController();
    const response = await runRoute(getActPostHandler(), {
      body: { kind: "click", ref: "btn-1", timeoutMs: 1234 },
      signal: ctrl.signal,
    });

    expect(response.statusCode).toBe(200);
    const clickParams = requireRecord(
      callArg(chromeMcpMocks.clickChromeMcpElement, 0, 0, "click params"),
      "click params",
    );
    expect(clickParams.profileName).toBe("chrome-live");
    expectExistingSessionProfile(clickParams.profile);
    expect(clickParams.targetId).toBe("7");
    expect(clickParams.uid).toBe("btn-1");
    expect(clickParams.doubleClick).toBe(false);
    expect(clickParams.timeoutMs).toBe(1234);
    expect(clickParams.signal).toBeInstanceOf(AbortSignal);
    const reason = new Error("caller cancelled");
    ctrl.abort(reason);
    expect(clickParams.signal).toMatchObject({ aborted: true, reason });
  });

  it("supports coordinate clicks for existing-session profiles", async () => {
    const response = await act({ kind: "clickCoords", x: 25, y: "32", doubleClick: true });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7", url: "https://example.com" });
    const click = requireRecord(
      chromeMcpMocks.clickChromeMcpCoords.mock.calls[0]?.[0],
      "click params",
    );
    expect(click).toMatchObject({
      profileName: "chrome-live",
      profile: existingProfile,
      targetId: "7",
      x: 25,
      y: 32,
      doubleClick: true,
    });
    expect(click.button).toBeUndefined();
    expect(click.delayMs).toBeUndefined();
  });

  it.each([{ button: "right" }, { delayMs: 5 }])(
    "rejects unsupported native coordinate input %j before clicking",
    async (options) => {
      const response = await runRoute(route("act"), {
        body: { kind: "clickCoords", x: 25, y: 32, ...options },
      });
      expect(response.statusCode).toBe(501);
      expect(chromeMcpMocks.clickChromeMcpCoords).not.toHaveBeenCalled();
    },
  );
});
