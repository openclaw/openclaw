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

const routeState = existingSessionRouteState;

const chromeMcpMocks = vi.hoisted(() => ({
  ChromeMcpDocumentUnavailableError: class ChromeMcpDocumentUnavailableError extends Error {},
  clickChromeMcpCoords: vi.fn(async () => {}),
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
  ChromeMcpDocumentUnavailableError: chromeMcpMocks.ChromeMcpDocumentUnavailableError,
  clickChromeMcpCoords: chromeMcpMocks.clickChromeMcpCoords,
  clickChromeMcpElement: chromeMcpMocks.clickChromeMcpElement,
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  evaluateChromeMcpScript: chromeMcpMocks.evaluateChromeMcpScript,
  fillChromeMcpElement: chromeMcpMocks.fillChromeMcpElement,
  selectChromeMcpOption: chromeMcpMocks.selectChromeMcpOption,
  fillChromeMcpForm: vi.fn(async () => {}),
  hoverChromeMcpElement: vi.fn(async () => {}),
  navigateChromeMcpPage: chromeMcpMocks.navigateChromeMcpPage,
  pressChromeMcpKey: vi.fn(async () => {}),
  resizeChromeMcpPage: vi.fn(async () => {}),
  takeChromeMcpScreenshot: chromeMcpMocks.takeChromeMcpScreenshot,
  takeChromeMcpSnapshot: chromeMcpMocks.takeChromeMcpSnapshot,
  withChromeMcpDocument: chromeMcpMocks.withChromeMcpDocument,
}));

vi.mock("../chrome-mcp-actions.js", () => ({
  takeChromeMcpScreenshotOnTarget: async (params: unknown) =>
    await chromeMcpMocks.takeChromeMcpScreenshot(params),
}));

vi.mock("../chrome-mcp-routing.js", () => ({
  resolveChromeMcpSnapshotRef: (_session: unknown, targetId: string, uid: string) => ({
    targetId,
    uid,
    documentUid: "root",
  }),
  withChromeMcpTarget: vi.fn(
    async (_params: unknown, run: (target: unknown) => Promise<unknown>) =>
      await run({ pageId: 7, profileOptions: {}, lease: { session: {} } }),
  ),
  callTool: async (
    profileName: string,
    _profile: unknown,
    name: string,
    args: { function: string; args: string[] },
    options: { signal?: AbortSignal; timeoutMs?: number },
  ) => {
    if (name !== "evaluate_script") {
      throw new Error(`Unexpected tool ${name}`);
    }
    const value = await chromeMcpMocks.evaluateChromeMcpScript({
      profileName,
      targetId: "7",
      fn: args.function,
      args: args.args,
      signal: options.signal,
      ...options,
    });
    return { structuredContent: { message: JSON.stringify(value) } };
  },
}));

vi.mock("../cdp.js", () => ({
  captureScreenshot: vi.fn(),
  snapshotAria: vi.fn(),
}));

vi.mock("../navigation-guard.js", () => ({
  assertBrowserNavigationAllowed: navigationGuardMocks.assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed: navigationGuardMocks.assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy: navigationGuardMocks.withBrowserNavigationPolicy,
}));

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

function getSnapshotGetHandler(ssrfPolicy?: unknown) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, {
    state: () => ({ resolved: { ssrfPolicy } }),
  } as never);
  const handler = getHandlers.get("/snapshot");
  expect(handler).toBeTypeOf("function");
  return handler;
}

function getSnapshotPostHandler(ssrfPolicy?: unknown) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, {
    state: () => ({ resolved: { ssrfPolicy } }),
  } as never);
  const handler = postHandlers.get("/screenshot");
  expect(handler).toBeTypeOf("function");
  return handler;
}

function getActPostHandler() {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActRoutes(app, {
    state: () => ({ resolved: { evaluateEnabled: true } }),
  } as never);
  const handler = postHandlers.get("/act");
  expect(handler).toBeTypeOf("function");
  return handler;
}

function getDialogHookPostHandler() {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActHookRoutes(app, {
    state: () => ({ resolved: {} }),
  } as never);
  const handler = postHandlers.get("/hooks/dialog");
  expect(handler).toBeTypeOf("function");
  return handler;
}

const requireRecord = createRequireRecord("object", "expected-label");

function callArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const call = calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call[argIndex];
}

function expectExistingSessionProfile(value: unknown) {
  const profile = requireRecord(value, "profile");
  expect(profile.name).toBe("chrome-live");
  expect(profile.driver).toBe("existing-session");
}

describe("existing-session browser routes", () => {
  beforeEach(() => {
    routeState.profileCtx.closeTab.mockClear();
    routeState.profileCtx.ensureTabAvailable.mockClear();
    routeState.profileCtx.listTabs.mockClear();
    chromeMcpMocks.clickChromeMcpCoords.mockClear();
    chromeMcpMocks.clickChromeMcpElement.mockClear();
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.fillChromeMcpElement.mockClear();
    chromeMcpMocks.selectChromeMcpOption.mockClear();
    chromeMcpMocks.navigateChromeMcpPage.mockClear();
    chromeMcpMocks.takeChromeMcpScreenshot.mockClear();
    chromeMcpMocks.takeChromeMcpSnapshot.mockClear();
    chromeMcpMocks.withChromeMcpDocument.mockClear();
    vi.mocked(withChromeMcpTarget).mockClear();
    navigationGuardMocks.assertBrowserNavigationAllowed.mockClear();
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockClear();
    navigationGuardMocks.withBrowserNavigationPolicy.mockClear();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(1).mockResolvedValueOnce(true);
  });

  it.each(["", "  spaced  "])("forwards exact select input %j to Chrome MCP", async (value) => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      { params: {}, query: {}, body: { kind: "select", ref: "select-1", values: [value] } },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.selectChromeMcpOption).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "7", uid: "select-1", value }),
    );
  });

  it("allows labeled AI snapshots for existing-session profiles", async () => {
    const handler = getSnapshotGetHandler();
    const response = createBrowserRouteResponse();
    const ctrl = new AbortController();
    await handler?.(
      { params: {}, query: { format: "ai", labels: "1" }, signal: ctrl.signal },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.ok).toBe(true);
    expect(body.format).toBe("ai");
    expect(body.labels).toBe(true);
    expect(body.labelsCount).toBe(1);
    expect(body.labelsSkipped).toBe(0);
    const snapshotParams = requireRecord(
      callArg(chromeMcpMocks.takeChromeMcpSnapshot, 0, 0, "snapshot params"),
      "snapshot params",
    );
    expect(snapshotParams.profileName).toBe("chrome-live");
    expectExistingSessionProfile(snapshotParams.profile);
    expect(snapshotParams.targetId).toBe("7");
    const renderParams = requireRecord(
      callArg(chromeMcpMocks.evaluateChromeMcpScript, 0, 0, "label params"),
      "label params",
    );
    const cleanupParams = requireRecord(
      callArg(chromeMcpMocks.evaluateChromeMcpScript, 1, 0, "label cleanup params"),
      "label cleanup params",
    );
    expect(renderParams.signal).toBeUndefined();
    expect(cleanupParams.signal).toBeUndefined();
    expect(cleanupParams.args).toEqual(["root"]);
    expect(withChromeMcpTarget).toHaveBeenCalledWith(
      expect.objectContaining({ signal: ctrl.signal }),
      expect.any(Function),
    );
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
    expect(chromeMcpMocks.takeChromeMcpScreenshot).toHaveBeenCalled();
  });

  it.each(
    ["snapshot", "screenshot"].flatMap((operation) =>
      [false, true].map((cleanupFails) => ({ operation, cleanupFails })),
    ),
  )(
    "preserves $operation cancellation when label cleanup fails=$cleanupFails",
    async ({ operation, cleanupFails }) => {
      const failure = new Error("label injection timed out");
      const controller = new AbortController();
      chromeMcpMocks.evaluateChromeMcpScript.mockReset().mockImplementationOnce(async () => {
        controller.abort(failure);
        throw failure;
      });
      if (cleanupFails) {
        chromeMcpMocks.evaluateChromeMcpScript.mockRejectedValueOnce(new Error("cleanup failed"));
      }
      const response = createBrowserRouteResponse();
      const handler = operation === "snapshot" ? getSnapshotGetHandler() : getSnapshotPostHandler();
      const request = handler?.(
        {
          params: {},
          query: { format: "ai", labels: "1" },
          body: { labels: true },
          signal: controller.signal,
        },
        response.res,
      );
      if (operation === "snapshot") {
        await request;
        expect(response.body).toEqual({ error: failure.message });
      } else {
        await expect(request).rejects.toBe(failure);
      }
      expect(chromeMcpMocks.takeChromeMcpScreenshot).not.toHaveBeenCalled();
      expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenLastCalledWith(
        expect.objectContaining({
          signal: undefined,
          fn: expect.stringContaining("node.remove()"),
        }),
      );
    },
  );

  it("joins cancelled label injection before cleaning its document", async () => {
    const controller = new AbortController();
    const failure = new Error("caller cancelled labels");
    const entered = createDeferred<void>();
    const complete = createDeferred<number>();
    chromeMcpMocks.evaluateChromeMcpScript.mockReset().mockImplementationOnce(async () => {
      entered.resolve();
      return await complete.promise;
    });
    const response = createBrowserRouteResponse();
    let settled = false;
    const request = Promise.resolve(
      getSnapshotPostHandler()?.(
        {
          params: {},
          query: {},
          body: { labels: true },
          signal: controller.signal,
        },
        response.res,
      ),
    ).finally(() => {
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

  it.each(["snapshot", "screenshot"])(
    "does not publish %s success before label cleanup",
    async (operation) => {
      const failure = new Error("cleanup failed after capture");
      chromeMcpMocks.evaluateChromeMcpScript
        .mockReset()
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(failure);
      const response = createBrowserRouteResponse();
      const publish = vi.spyOn(response.res, "json");
      const handler = operation === "snapshot" ? getSnapshotGetHandler() : getSnapshotPostHandler();
      const request = handler?.(
        { params: {}, query: { format: "ai", labels: "1" }, body: { labels: true } },
        response.res,
      );
      if (operation === "snapshot") {
        await request;
        expect(publish).toHaveBeenCalledExactlyOnceWith({ error: failure.message });
      } else {
        await expect(request).rejects.toBe(failure);
        expect(publish).not.toHaveBeenCalled();
      }
      expect(chromeMcpMocks.takeChromeMcpScreenshot).toHaveBeenCalledOnce();
    },
  );

  it.each(["snapshot", "screenshot"])(
    "clears %s labels after media persistence fails and its caller aborts",
    async (operation) => {
      const failure = new Error("media persistence failed");
      const controller = new AbortController();
      vi.mocked(saveMediaBuffer).mockImplementationOnce(async () => {
        controller.abort();
        throw failure;
      });
      const response = createBrowserRouteResponse();
      const handler = operation === "snapshot" ? getSnapshotGetHandler() : getSnapshotPostHandler();
      const request = handler?.(
        {
          params: {},
          query: { format: "ai", labels: "1" },
          body: { labels: true },
          signal: controller.signal,
        },
        response.res,
      );
      if (operation === "snapshot") {
        await request;
        expect(response.body).toEqual({ error: failure.message });
      } else {
        await expect(request).rejects.toBe(failure);
        expect(response.body).toBeUndefined();
      }
      expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenLastCalledWith(
        expect.objectContaining({
          signal: undefined,
          fn: expect.stringContaining("node.remove()"),
        }),
      );
    },
  );

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
    const first = createBrowserRouteResponse();
    const second = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai" } }, first.res);
    await handler?.({ params: {}, query: { format: "ai" } }, second.res);

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
    const handler = getSnapshotGetHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      { params: {}, query: { format: "ai", labels: "1", maxChars: String(maxChars) } },
      response.res,
    );

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
      callArg(chromeMcpMocks.evaluateChromeMcpScript, 0, 0, "label params"),
      "label params",
    );
    expect(renderParams.fn).toContain('"btn-1"');
    expect(renderParams.fn).not.toContain('"btn-2"');
  });

  it("reports automatic Chrome MCP depth truncation through AI and ARIA routes", async () => {
    let root: ChromeMcpSnapshotNode = { id: "leaf", role: "text", name: "leaf" };
    for (let index = 0; index < 1_000; index += 1) {
      root = { id: `n${index}`, role: "generic", name: `n${index}`, children: [root] };
    }
    chromeMcpMocks.takeChromeMcpSnapshot
      .mockResolvedValueOnce(root)
      .mockResolvedValueOnce(root)
      .mockResolvedValueOnce(root);
    const handler = getSnapshotGetHandler();

    const ai = createBrowserRouteResponse();
    await handler?.({ params: {}, query: { format: "ai" } }, ai.res);
    const aiBody = requireRecord(ai.body, "AI snapshot body");
    expect(aiBody.truncated).toBe(true);
    expect(aiBody.snapshot).toContain("[...TRUNCATED - accessibility tree too deep]");

    const aria = createBrowserRouteResponse();
    await handler?.({ params: {}, query: { format: "aria" } }, aria.res);
    const ariaBody = requireRecord(aria.body, "ARIA snapshot body");
    expect(ariaBody.truncated).toBe(true);
    expect(ariaBody.nodes).toHaveLength(101);

    const requestedDepth = createBrowserRouteResponse();
    await handler?.({ params: {}, query: { format: "ai", depth: "5" } }, requestedDepth.res);
    const requestedDepthBody = requireRecord(requestedDepth.body, "requested-depth snapshot body");
    expect(requestedDepthBody.truncated).toBeUndefined();
    expect(requestedDepthBody.snapshot).not.toContain("TRUNCATED");
  });

  it("reports automatic Chrome MCP depth truncation on labeled screenshots", async () => {
    let root: ChromeMcpSnapshotNode = { id: "leaf", role: "text", name: "leaf" };
    for (let index = 0; index < 1_000; index += 1) {
      root = { id: `n${index}`, role: "generic", name: `n${index}`, children: [root] };
    }
    chromeMcpMocks.takeChromeMcpSnapshot.mockResolvedValueOnce(root);
    const handler = getSnapshotPostHandler();
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: {}, body: { labels: true } }, response.res);

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "labeled screenshot body");
    expect(body.labels).toBe(true);
    expect(body.truncated).toBe(true);
  });

  it("allows ref screenshots for existing-session profiles", async () => {
    const handler = getSnapshotPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { ref: "btn-1", type: "jpeg", timeoutMs: 4321 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.ok).toBe(true);
    expect(body.path).toBe("/tmp/fake.png");
    expect(body.targetId).toBe("7");
    const screenshotParams = requireRecord(
      callArg(chromeMcpMocks.takeChromeMcpScreenshot, 0, 0, "screenshot params"),
      "screenshot params",
    );
    expect(screenshotParams.profileName).toBe("chrome-live");
    expectExistingSessionProfile(screenshotParams.profile);
    expect(screenshotParams.targetId).toBe("7");
    expect(screenshotParams.uid).toBe("btn-1");
    expect(screenshotParams.fullPage).toBe(false);
    expect(screenshotParams.format).toBe("jpeg");
    expect(screenshotParams.timeoutMs).toBe(4321);
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("keeps ref semantics for labeled existing-session screenshots", async () => {
    const handler = getSnapshotPostHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { labels: true, ref: "btn-1", type: "jpeg", timeoutMs: 4321 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, labels: true });
    expect(chromeMcpMocks.takeChromeMcpSnapshot).not.toHaveBeenCalled();
    expect(chromeMcpMocks.takeChromeMcpScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "btn-1", format: "jpeg", timeoutMs: 4321 }),
    );
  });

  it("routes close through profile selection state with exact call options", async () => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    const ctrl = new AbortController();

    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "close", targetId: "7", timeoutMs: 4321 },
        signal: ctrl.signal,
      },
      response.res,
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

  it("allows existing-session snapshots under the default SSRF policy object", async () => {
    const handler = getSnapshotGetHandler({});
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai" } }, response.res);

    expect(response.statusCode).toBe(200);
    expect(navigationGuardMocks.assertBrowserNavigationAllowed).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "https://example.com",
      ssrfPolicy: {},
    });
    expect(chromeMcpMocks.takeChromeMcpSnapshot).toHaveBeenCalled();
  });

  it("blocks existing-session snapshots when the current URL violates browser navigation policy", async () => {
    routeState.profileCtx.ensureTabAvailable.mockResolvedValueOnce({
      targetId: "7",
      url: "http://127.0.0.1:8080/admin",
    });
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      new Error("browser navigation blocked by policy"),
    );
    const handler = getSnapshotGetHandler({ allowPrivateNetwork: false });
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai" } }, response.res);

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
    const handler = getSnapshotGetHandler({ allowPrivateNetwork: false });
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai", selector: "#admin" } }, response.res);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: EXISTING_SESSION_LIMITS.snapshot.snapshotSelector,
    });
    expect(navigationGuardMocks.assertBrowserNavigationAllowed).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
    expect(chromeMcpMocks.takeChromeMcpSnapshot).not.toHaveBeenCalled();
  });

  it("checks existing-session screenshot URL when SSRF policy is configured", async () => {
    const handler = getSnapshotPostHandler({ allowPrivateNetwork: false });
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { ref: "btn-1", type: "jpeg" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "https://example.com",
      ssrfPolicy: { allowPrivateNetwork: false },
    });
  });

  it("rejects selector-based element screenshots for existing-session profiles", async () => {
    const handler = getSnapshotPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { element: "#submit" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(400);
    const body = requireRecord(response.body, "response body");
    expect(String(body.error)).toContain("element screenshots are not supported");
    expect(chromeMcpMocks.takeChromeMcpScreenshot).not.toHaveBeenCalled();
  });

  it("fails closed for existing-session networkidle waits", async () => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "wait", loadState: "networkidle" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(501);
    const body = requireRecord(response.body, "response body");
    expect(String(body.error)).toContain("loadState=networkidle");
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("fails closed for existing-session type timeout overrides", async () => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "type", ref: "input-1", text: "hello", timeoutMs: 1234 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(501);
    const body = requireRecord(response.body, "response body");
    expect(String(body.error)).toContain("type does not support timeoutMs");
    expect(chromeMcpMocks.fillChromeMcpElement).not.toHaveBeenCalled();
  });

  it("explains unsupported focused paste without forwarding or echoing its text", async () => {
    const response = createBrowserRouteResponse();
    await getActPostHandler()?.(
      {
        params: {},
        query: {},
        body: { kind: "insertText", text: "synthetic-password-paste" },
      },
      response.res,
    );

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
    const handler = getDialogHookPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { accept: true, dialogId: "d1" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(501);
    const body = requireRecord(response.body, "response body");
    expect(String(body.error)).toContain("dialogId");
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("supports glob URL waits for existing-session profiles", async () => {
    const evaluate = vi.fn(async (_fn: string) => "https://example.com/");
    chromeMcpMocks.withChromeMcpDocument.mockImplementationOnce(
      async (_params, task) => await task({ evaluate }),
    );

    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "wait", url: "**/example.com/" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.ok).toBe(true);
    expect(body.targetId).toBe("7");
    const documentParams = requireRecord(
      callArg(chromeMcpMocks.withChromeMcpDocument, 0, 0, "document params"),
      "document params",
    );
    expect(documentParams.profileName).toBe("chrome-live");
    expectExistingSessionProfile(documentParams.profile);
    expect(documentParams.userDataDir).toBeUndefined();
    expect(documentParams.targetId).toBe("7");
    expect(evaluate).toHaveBeenCalledOnce();
    expect(String(evaluate.mock.calls[0]?.[0])).toContain("location.href");
  });

  it("forwards click timeoutMs to the existing-session click executor", async () => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    const ctrl = new AbortController();

    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "click", ref: "btn-1", timeoutMs: 1234 },
        signal: ctrl.signal,
      },
      response.res,
    );

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
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "clickCoords", x: 25, y: "32", doubleClick: true },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.ok).toBe(true);
    expect(body.targetId).toBe("7");
    expect(body.url).toBe("https://example.com");
    const clickParams = requireRecord(
      callArg(chromeMcpMocks.clickChromeMcpCoords, 0, 0, "coordinate click params"),
      "coordinate click params",
    );
    expect(clickParams.profileName).toBe("chrome-live");
    expectExistingSessionProfile(clickParams.profile);
    expect(clickParams.targetId).toBe("7");
    expect(clickParams.x).toBe(25);
    expect(clickParams.y).toBe(32);
    expect(clickParams.doubleClick).toBe(true);
    expect(clickParams.button).toBeUndefined();
    expect(clickParams.delayMs).toBeUndefined();
  });

  it.each([{ button: "right" }, { button: "middle" }, { delayMs: 5 }])(
    "rejects unsupported native coordinate input %j before clicking",
    async (options) => {
      const handler = getActPostHandler();
      const response = createBrowserRouteResponse();
      await handler?.(
        { params: {}, query: {}, body: { kind: "clickCoords", x: 25, y: 32, ...options } },
        response.res,
      );
      expect(response.statusCode).toBe(501);
      expect(chromeMcpMocks.clickChromeMcpCoords).not.toHaveBeenCalled();
    },
  );
});
