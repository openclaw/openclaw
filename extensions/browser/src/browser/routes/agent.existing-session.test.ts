// Browser tests cover agent.existing session plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import {
  createExistingSessionAgentSharedModule,
  existingSessionRouteState,
} from "./existing-session.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const routeState = existingSessionRouteState;

const chromeMcpMocks = vi.hoisted(() => ({
  clickChromeMcpCoords: vi.fn(async () => {}),
  clickChromeMcpElement: vi.fn(async () => {}),
  emulateChromeMcpPage: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(
    async (_params: { profileName: string; targetId: string; fn: string }) => true,
  ),
  fillChromeMcpElement: vi.fn(async () => {}),
  handleChromeMcpDialog: vi.fn(async () => {
    throw new Error("No open dialog found");
  }),
  navigateChromeMcpPage: vi.fn(async ({ url }: { url: string }) => ({ url })),
  takeChromeMcpScreenshot: vi.fn(async () => Buffer.from("png")),
  takeChromeMcpSnapshot: vi.fn(async () => ({
    id: "root",
    role: "document",
    name: "Example",
    children: [{ id: "btn-1", role: "button", name: "Continue" }],
  })),
  waitForChromeMcpText: vi.fn(async () => {}),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../chrome-mcp.js", () => ({
  clickChromeMcpCoords: chromeMcpMocks.clickChromeMcpCoords,
  clickChromeMcpElement: chromeMcpMocks.clickChromeMcpElement,
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  emulateChromeMcpPage: chromeMcpMocks.emulateChromeMcpPage,
  evaluateChromeMcpScript: chromeMcpMocks.evaluateChromeMcpScript,
  fillChromeMcpElement: chromeMcpMocks.fillChromeMcpElement,
  fillChromeMcpForm: vi.fn(async () => {}),
  handleChromeMcpDialog: chromeMcpMocks.handleChromeMcpDialog,
  hoverChromeMcpElement: vi.fn(async () => {}),
  navigateChromeMcpPage: chromeMcpMocks.navigateChromeMcpPage,
  pressChromeMcpKey: vi.fn(async () => {}),
  resizeChromeMcpPage: vi.fn(async () => {}),
  takeChromeMcpScreenshot: chromeMcpMocks.takeChromeMcpScreenshot,
  takeChromeMcpSnapshot: chromeMcpMocks.takeChromeMcpSnapshot,
  waitForChromeMcpText: chromeMcpMocks.waitForChromeMcpText,
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
    contentType: "image/png",
  })),
}));

vi.mock("../../media/store.js", () => ({
  ensureMediaDir: vi.fn(async () => {}),
  saveMediaBuffer: vi.fn(async () => ({ path: "/tmp/fake.png" })),
}));

vi.mock("./agent.shared.js", () => createExistingSessionAgentSharedModule());

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");
const { registerBrowserAgentActHookRoutes } = await import("./agent.act.hooks.js");
const { registerBrowserAgentSnapshotRoutes } = await import("./agent.snapshot.js");
const { registerBrowserAgentStorageRoutes } = await import("./agent.storage.js");

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

function getStoragePostHandler(path: string) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentStorageRoutes(app, {
    state: () => ({ resolved: {} }),
  } as never);
  const handler = postHandlers.get(path);
  expect(handler).toBeTypeOf("function");
  return handler;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

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
    routeState.profileCtx.ensureTabAvailable.mockClear();
    routeState.profileCtx.listTabs.mockClear();
    chromeMcpMocks.clickChromeMcpCoords.mockClear();
    chromeMcpMocks.clickChromeMcpElement.mockClear();
    chromeMcpMocks.emulateChromeMcpPage.mockClear();
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.fillChromeMcpElement.mockClear();
    chromeMcpMocks.handleChromeMcpDialog.mockReset().mockRejectedValue(new Error("No open dialog found"));
    chromeMcpMocks.navigateChromeMcpPage.mockClear();
    chromeMcpMocks.takeChromeMcpScreenshot.mockClear();
    chromeMcpMocks.takeChromeMcpSnapshot.mockClear();
    chromeMcpMocks.waitForChromeMcpText.mockClear();
    navigationGuardMocks.assertBrowserNavigationAllowed.mockClear();
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockClear();
    navigationGuardMocks.withBrowserNavigationPolicy.mockClear();
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce({ labels: 1, skipped: 0 } as never)
      .mockResolvedValueOnce(true);
  });

  it("allows labeled AI snapshots for existing-session profiles", async () => {
    const handler = getSnapshotGetHandler();
    const response = createBrowserRouteResponse();
    await handler?.({ params: {}, query: { format: "ai", labels: "1" } }, response.res);

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
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
    expect(chromeMcpMocks.takeChromeMcpScreenshot).toHaveBeenCalled();
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

  it("checks existing-session snapshot URL when SSRF policy is configured", async () => {
    const handler = getSnapshotGetHandler({ allowPrivateNetwork: false });
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: { format: "ai" } }, response.res);

    expect(response.statusCode).toBe(200);
    expect(navigationGuardMocks.assertBrowserNavigationAllowed).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "https://example.com",
      ssrfPolicy: { allowPrivateNetwork: false },
    });
    expect(chromeMcpMocks.takeChromeMcpSnapshot).toHaveBeenCalled();
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

  it("selects existing-session <select> refs with an evaluate fallback", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset().mockResolvedValue(true as never);
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "select", ref: "choice-1", values: ["beta"] },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.ok).toBe(true);
    const evaluateParams = requireRecord(
      callArg(chromeMcpMocks.evaluateChromeMcpScript, 0, 0, "evaluate params"),
      "evaluate params",
    );
    expect(evaluateParams.profileName).toBe("chrome-live");
    expectExistingSessionProfile(evaluateParams.profile);
    expect(evaluateParams.targetId).toBe("7");
    expect(evaluateParams.args).toEqual(["choice-1"]);
    expect(String(evaluateParams.fn)).toContain("HTMLSelectElement");
    expect(String(evaluateParams.fn)).toContain("beta");
    expect(chromeMcpMocks.fillChromeMcpElement).not.toHaveBeenCalled();
  });

  it("ignores dialog timeout defaults for existing-session dialog hooks", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset().mockResolvedValue(true as never);
    const handler = getDialogHookPostHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { accept: true, promptText: "approved", timeoutMs: 120000 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.ok).toBe(true);
    const evaluateParams = requireRecord(
      callArg(chromeMcpMocks.evaluateChromeMcpScript, 0, 0, "dialog hook evaluate params"),
      "dialog hook evaluate params",
    );
    expect(evaluateParams.profileName).toBe("chrome-live");
    expectExistingSessionProfile(evaluateParams.profile);
    expect(evaluateParams.targetId).toBe("7");
    expect(String(evaluateParams.fn)).toContain("window.prompt");
    expect(String(evaluateParams.fn)).toContain("approved");
    expect(chromeMcpMocks.handleChromeMcpDialog).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
      targetId: "7",
      action: "accept",
      promptText: "approved",
    });
  });

  it("handles active existing-session dialogs with Chrome MCP handle_dialog before pre-arming", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset().mockResolvedValue(true as never);
    chromeMcpMocks.handleChromeMcpDialog.mockReset().mockResolvedValue(undefined as never);
    const handler = getDialogHookPostHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { accept: false },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.ok).toBe(true);
    expect(chromeMcpMocks.handleChromeMcpDialog).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
      targetId: "7",
      action: "dismiss",
      promptText: undefined,
    });
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
    expect(chromeMcpMocks.handleChromeMcpDialog).not.toHaveBeenCalled();
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("supports glob URL waits for existing-session profiles", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockImplementation(
      async ({ fn }: { fn: string }) =>
        (fn === "() => window.location.href" ? "https://example.com/" : true) as never,
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
    const evaluateParams = requireRecord(
      callArg(chromeMcpMocks.evaluateChromeMcpScript, 0, 0, "evaluate params"),
      "evaluate params",
    );
    expect(evaluateParams.profileName).toBe("chrome-live");
    expectExistingSessionProfile(evaluateParams.profile);
    expect(evaluateParams.userDataDir).toBeUndefined();
    expect(evaluateParams.targetId).toBe("7");
    expect(evaluateParams.fn).toBe("() => window.location.href");
  });

  it("uses native Chrome MCP wait_for for text-only existing-session waits", async () => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "wait", text: "Ready", timeoutMs: 1234 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.ok).toBe(true);
    expect(body.targetId).toBe("7");
    const waitParams = requireRecord(
      callArg(chromeMcpMocks.waitForChromeMcpText, 0, 0, "wait_for params"),
      "wait_for params",
    );
    expect(waitParams.profileName).toBe("chrome-live");
    expectExistingSessionProfile(waitParams.profile);
    expect(waitParams.targetId).toBe("7");
    expect(waitParams.text).toEqual(["Ready"]);
    expect(waitParams.timeoutMs).toBe(1234);
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
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
    expect(clickParams.signal).toBe(ctrl.signal);
  });

  it("supports coordinate clicks for existing-session profiles", async () => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "clickCoords", x: 25, y: "32", doubleClick: true, delayMs: 5 },
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
    expect(clickParams.delayMs).toBe(5);
  });

  it("routes existing-session offline changes through Chrome MCP emulate", async () => {
    const handler = getStoragePostHandler("/set/offline");
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { offline: true },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.ok).toBe(true);
    expect(body.targetId).toBe("7");
    expect(chromeMcpMocks.emulateChromeMcpPage).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
      targetId: "7",
      offline: true,
    });
  });

  it("routes existing-session headers through Chrome MCP emulate", async () => {
    const handler = getStoragePostHandler("/set/headers");
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { headers: { "x-openclaw-test": "yes", ignored: 7 } },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.emulateChromeMcpPage).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
      targetId: "7",
      extraHttpHeaders: { "x-openclaw-test": "yes" },
    });
  });

  it("routes existing-session geolocation through Chrome MCP emulate", async () => {
    const handler = getStoragePostHandler("/set/geolocation");
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { latitude: 49.2827, longitude: -123.1207, origin: "https://example.com" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.permissionGrantUnsupported).toBe(true);
    expect(chromeMcpMocks.emulateChromeMcpPage).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
      targetId: "7",
      geolocation: { latitude: 49.2827, longitude: -123.1207 },
    });
  });

  it("routes existing-session media color-scheme through Chrome MCP emulate", async () => {
    const handler = getStoragePostHandler("/set/media");
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { colorScheme: "no-preference" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.emulateChromeMcpPage).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
      targetId: "7",
      colorScheme: "auto",
    });
  });
});
