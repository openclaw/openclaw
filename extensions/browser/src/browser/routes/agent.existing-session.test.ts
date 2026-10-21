import "./agent.snapshot-mocks.test-support.js";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMcpSnapshotNode } from "../chrome-mcp.snapshot.js";
import {
  expectResponse,
  expectResponseContaining,
  runRoute,
  startRoute,
  gate,
} from "./agent-route.test-support.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import {
  createExistingSessionAgentSharedModule,
  existingSessionRouteState,
} from "./existing-session.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const routeState = existingSessionRouteState;

const mcp = vi.hoisted(() => ({
  ChromeMcpDocumentUnavailableError: class ChromeMcpDocumentUnavailableError extends Error {},
  clickChromeMcpCoords: vi.fn(async (_params: unknown) => {}),
  clickChromeMcpElement: vi.fn(async (_params: unknown) => {}),
  evaluateChromeMcpScript: vi.fn(
    async (
      _params: Parameters<typeof import("../chrome-mcp.js").evaluateChromeMcpScript>[0],
    ): Promise<unknown> => true,
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

const navigation = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

// mock-isolation: Supply deterministic browser documents and effects without a live Chrome session.
vi.mock("../chrome-mcp.js", () => ({
  ...mcp,
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  fillChromeMcpForm: vi.fn(async () => {}),
  hoverChromeMcpElement: vi.fn(async () => {}),
  pressChromeMcpKey: vi.fn(async () => {}),
  resizeChromeMcpPage: vi.fn(async () => {}),
}));

// mock-isolation: Route screenshot capture through the same controlled transport fixture.
vi.mock("../chrome-mcp-actions.js", () => ({
  takeChromeMcpScreenshotOnTarget: async (params: unknown) =>
    await mcp.takeChromeMcpScreenshot(params),
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
          const value = await mcp.evaluateChromeMcpScript({
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

// mock-isolation: Existing-session routes must not connect through the managed CDP transport.
vi.mock("../cdp.js", () => ({ captureScreenshot: vi.fn(), snapshotAria: vi.fn() }));

// mock-isolation: Observe route policy calls without resolving or connecting to fixture URLs.
vi.mock("../navigation-guard.js", () => navigation);

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
  expect(mcp.evaluateChromeMcpScript).toHaveBeenLastCalledWith(
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
    mcp.evaluateChromeMcpScript.mockReset().mockResolvedValueOnce(1).mockResolvedValueOnce(true);
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
    mcp.evaluateChromeMcpScript
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
    expect(mcp.takeChromeMcpScreenshot).not.toHaveBeenCalled();
    expectLabelCleanup();
  });

  it("joins cancelled label injection before cleaning its document", async () => {
    const controller = new AbortController();
    const failure = new Error("caller cancelled labels");
    const labels = gate<number>();
    mcp.evaluateChromeMcpScript.mockReset().mockImplementationOnce(labels.block);
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
    expect(mcp.takeChromeMcpScreenshot).not.toHaveBeenCalled();
    expectLabelCleanup();
    expect(mcp.evaluateChromeMcpScript).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: ["root"] }),
    );
  });

  it("does not publish screenshot success before label cleanup", async () => {
    const failure = new Error("cleanup failed after capture");
    mcp.evaluateChromeMcpScript.mockReset().mockResolvedValueOnce(1).mockRejectedValueOnce(failure);
    const response = createBrowserRouteResponse();
    const publish = vi.spyOn(response.res, "json");
    const completion = route("screenshot")?.(
      { params: {}, query: {}, body: { labels: true } },
      response.res,
    );
    await expect(completion).rejects.toBe(failure);
    expect(publish).not.toHaveBeenCalled();
    expect(mcp.takeChromeMcpScreenshot).toHaveBeenCalledOnce();
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
    mcp.takeChromeMcpSnapshot
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
    const handler = route("snapshot");
    await runRoute(handler, { query: { format: "ai" } });
    const second = await runRoute(handler, { query: { format: "ai" } });

    const body = requireRecord(second.body, "second snapshot body");
    expect(body.snapshot).not.toContain("[new]");
    expect(body.newElements).toBeUndefined();
  });

  it("labels and returns only Chrome MCP refs inside the final snapshot budget", async () => {
    mcp.takeChromeMcpSnapshot.mockResolvedValueOnce({
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
    const render = mcp.evaluateChromeMcpScript.mock.calls[0]?.[0];
    expect(render?.fn).toContain('"btn-1"');
    expect(render?.fn).not.toContain('"btn-2"');
  });

  it.each([
    ["snapshot", { format: "ai" }, true],
    ["snapshot", { format: "aria" }, true],
    ["snapshot", { format: "ai", depth: "5" }, undefined],
    ["screenshot", { labels: true }, true],
  ] as const)("reports depth truncation for %s %j", async (kind, input, truncated) => {
    mcp.takeChromeMcpSnapshot.mockResolvedValueOnce(deepSnapshot());
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
    expect(mcp.takeChromeMcpSnapshot).not.toHaveBeenCalled();
    expect(mcp.takeChromeMcpScreenshot).toHaveBeenCalledWith(
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
    expect(mcp.takeChromeMcpSnapshot).not.toHaveBeenCalled();
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
    expect(mcp.takeChromeMcpScreenshot).not.toHaveBeenCalled();
  });

  it.each([
    [
      "act",
      { kind: "wait", loadState: "networkidle" },
      "loadState=networkidle",
      mcp.evaluateChromeMcpScript,
    ],
    [
      "act",
      { kind: "type", ref: "input-1", text: "hello", timeoutMs: 1234 },
      "type does not support timeoutMs",
      mcp.fillChromeMcpElement,
    ],
    ["dialog", { accept: true, dialogId: "d1" }, "dialogId", mcp.evaluateChromeMcpScript],
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
    expect(mcp.fillChromeMcpElement).not.toHaveBeenCalled();
    expect(mcp.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("supports glob URL waits for existing-session profiles", async () => {
    const evaluate = vi.fn(async (_fn: string) => "https://example.com/");
    mcp.withChromeMcpDocument.mockImplementationOnce(
      async (_params, task) => await task({ evaluate }),
    );

    const response = await invoke("act", { kind: "wait", url: "**/example.com/" });

    expectResponseContaining(response, { ok: true, targetId: "7" });
    const documentParams = requireRecord(
      mcp.withChromeMcpDocument.mock.calls[0]?.[0],
      "document params",
    );
    expect(documentParams).toMatchObject(existingTarget);
    expect(documentParams.userDataDir).toBeUndefined();
    expect(evaluate).toHaveBeenCalledOnce();
    expect(String(evaluate.mock.calls[0]?.[0])).toContain("location.href");
  });

  it("forwards click timeoutMs to the existing-session click executor", async () => {
    const ctrl = new AbortController();
    const response = await runRoute(route("act"), {
      body: { kind: "click", ref: "btn-1", timeoutMs: 1234 },
      signal: ctrl.signal,
    });

    expect(response.statusCode).toBe(200);
    const clickParams = requireRecord(mcp.clickChromeMcpElement.mock.calls[0]?.[0], "click params");
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
    const click = requireRecord(mcp.clickChromeMcpCoords.mock.calls[0]?.[0], "click params");
    expect(click).toMatchObject({
      ...existingTarget,
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
      const response = await invoke("act", { kind: "clickCoords", x: 25, y: 32, ...options });
      expect(response.statusCode).toBe(501);
      expect(mcp.clickChromeMcpCoords).not.toHaveBeenCalled();
    },
  );
});
