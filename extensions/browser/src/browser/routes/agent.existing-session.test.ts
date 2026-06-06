// Browser tests cover agent.existing session plugin behavior.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import {
  createExistingSessionAgentSharedModule,
  existingSessionRouteState,
} from "./existing-session.test-support.js";
import { DEFAULT_TRACE_DIR } from "./path-output.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const routeState = existingSessionRouteState;

const chromeMcpMocks = vi.hoisted(() => ({
  analyzeChromeMcpPerformanceInsight: vi.fn(async () => "Insight details."),
  clickChromeMcpCoords: vi.fn(async () => {}),
  clickChromeMcpElement: vi.fn(async () => {}),
  emulateChromeMcpPage: vi.fn(async () => {}),
  executeChromeMcpThirdPartyDeveloperTool: vi.fn(async () => ({ output: "3p executed" })),
  executeChromeMcpWebMcpTool: vi.fn(async () => ({ output: "webmcp executed" })),
  evaluateChromeMcpScript: vi.fn(
    async (_params: { profileName: string; targetId: string; fn: string }) => true,
  ),
  fillChromeMcpElement: vi.fn(async () => {}),
  getChromeMcpConsoleMessage: vi.fn(async () => ({ text: "detail" })),
  getChromeMcpHeapSnapshotClassNodes: vi.fn(async () => ({ output: "class nodes" })),
  getChromeMcpHeapSnapshotDetails: vi.fn(async () => ({ output: "details" })),
  getChromeMcpHeapSnapshotRetainers: vi.fn(async () => ({ output: "retainers" })),
  getChromeMcpHeapSnapshotSummary: vi.fn(async () => ({ output: "summary" })),
  getChromeMcpNetworkRequest: vi.fn(async () => ({ url: "https://example.com/api" })),
  getChromeMcpTabId: vi.fn(async () => "123"),
  handleChromeMcpDialog: vi.fn(async () => {
    throw new Error("No open dialog found");
  }),
  installChromeMcpExtension: vi.fn(async () => "installed"),
  listChromeMcpExtensions: vi.fn(async () => [{ id: "ext-1", name: "Extension" }]),
  navigateChromeMcpPage: vi.fn(async ({ url }: { url: string }) => ({ url })),
  listChromeMcpThirdPartyDeveloperTools: vi.fn(async () => ({ output: "3p tools" })),
  listChromeMcpWebMcpTools: vi.fn(async () => ({ output: "webmcp tools" })),
  reloadChromeMcpExtension: vi.fn(async () => "reloaded"),
  runChromeMcpLighthouseAudit: vi.fn(async () => ({ output: "lighthouse" })),
  startChromeMcpPerformanceTrace: vi.fn(async () => "The performance trace is being recorded."),
  startChromeMcpScreencast: vi.fn(async () => "screencast started"),
  stopChromeMcpPerformanceTrace: vi.fn(async () => "The performance trace has been stopped."),
  stopChromeMcpScreencast: vi.fn(async () => "screencast stopped"),
  takeChromeMcpScreenshot: vi.fn(async () => Buffer.from("png")),
  takeChromeMcpHeapSnapshot: vi.fn(async () => "heap written"),
  takeChromeMcpSnapshot: vi.fn(async () => ({
    id: "root",
    role: "document",
    name: "Example",
    children: [{ id: "btn-1", role: "button", name: "Continue" }],
  })),
  triggerChromeMcpExtensionAction: vi.fn(async () => "triggered"),
  uninstallChromeMcpExtension: vi.fn(async () => "uninstalled"),
  waitForChromeMcpText: vi.fn(async () => {}),
}));

const cdpMocks = vi.hoisted(() => ({
  handleJavaScriptDialogViaCdp: vi.fn(async () => {}),
  printPdfViaCdp: vi.fn(async () => ({ buffer: Buffer.from("%PDF-1.7") })),
  setExtraHTTPHeadersViaCdp: vi.fn(async () => {}),
}));

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: unknown, stdout: string, stderr: string) => void,
    ) => {
      callback(
        null,
        JSON.stringify({
          streams: [
            {
              codec_name: "vp9",
              width: 640,
              height: 360,
              r_frame_rate: "25/1",
              avg_frame_rate: "25/1",
              nb_read_frames: "42",
            },
          ],
        }),
        "",
      );
      return {} as never;
    },
  ),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../chrome-mcp.js", () => ({
  analyzeChromeMcpPerformanceInsight: chromeMcpMocks.analyzeChromeMcpPerformanceInsight,
  clickChromeMcpCoords: chromeMcpMocks.clickChromeMcpCoords,
  clickChromeMcpElement: chromeMcpMocks.clickChromeMcpElement,
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  emulateChromeMcpPage: chromeMcpMocks.emulateChromeMcpPage,
  executeChromeMcpThirdPartyDeveloperTool: chromeMcpMocks.executeChromeMcpThirdPartyDeveloperTool,
  executeChromeMcpWebMcpTool: chromeMcpMocks.executeChromeMcpWebMcpTool,
  evaluateChromeMcpScript: chromeMcpMocks.evaluateChromeMcpScript,
  fillChromeMcpElement: chromeMcpMocks.fillChromeMcpElement,
  fillChromeMcpForm: vi.fn(async () => {}),
  getChromeMcpConsoleMessage: chromeMcpMocks.getChromeMcpConsoleMessage,
  getChromeMcpHeapSnapshotClassNodes: chromeMcpMocks.getChromeMcpHeapSnapshotClassNodes,
  getChromeMcpHeapSnapshotDetails: chromeMcpMocks.getChromeMcpHeapSnapshotDetails,
  getChromeMcpHeapSnapshotRetainers: chromeMcpMocks.getChromeMcpHeapSnapshotRetainers,
  getChromeMcpHeapSnapshotSummary: chromeMcpMocks.getChromeMcpHeapSnapshotSummary,
  getChromeMcpNetworkRequest: chromeMcpMocks.getChromeMcpNetworkRequest,
  getChromeMcpTabId: chromeMcpMocks.getChromeMcpTabId,
  handleChromeMcpDialog: chromeMcpMocks.handleChromeMcpDialog,
  hoverChromeMcpElement: vi.fn(async () => {}),
  installChromeMcpExtension: chromeMcpMocks.installChromeMcpExtension,
  listChromeMcpExtensions: chromeMcpMocks.listChromeMcpExtensions,
  navigateChromeMcpPage: chromeMcpMocks.navigateChromeMcpPage,
  listChromeMcpThirdPartyDeveloperTools: chromeMcpMocks.listChromeMcpThirdPartyDeveloperTools,
  listChromeMcpWebMcpTools: chromeMcpMocks.listChromeMcpWebMcpTools,
  reloadChromeMcpExtension: chromeMcpMocks.reloadChromeMcpExtension,
  runChromeMcpLighthouseAudit: chromeMcpMocks.runChromeMcpLighthouseAudit,
  startChromeMcpPerformanceTrace: chromeMcpMocks.startChromeMcpPerformanceTrace,
  startChromeMcpScreencast: chromeMcpMocks.startChromeMcpScreencast,
  pressChromeMcpKey: vi.fn(async () => {}),
  resizeChromeMcpPage: vi.fn(async () => {}),
  stopChromeMcpPerformanceTrace: chromeMcpMocks.stopChromeMcpPerformanceTrace,
  stopChromeMcpScreencast: chromeMcpMocks.stopChromeMcpScreencast,
  takeChromeMcpHeapSnapshot: chromeMcpMocks.takeChromeMcpHeapSnapshot,
  takeChromeMcpScreenshot: chromeMcpMocks.takeChromeMcpScreenshot,
  takeChromeMcpSnapshot: chromeMcpMocks.takeChromeMcpSnapshot,
  triggerChromeMcpExtensionAction: chromeMcpMocks.triggerChromeMcpExtensionAction,
  uninstallChromeMcpExtension: chromeMcpMocks.uninstallChromeMcpExtension,
  waitForChromeMcpText: chromeMcpMocks.waitForChromeMcpText,
}));

vi.mock("../cdp.js", () => ({
  captureScreenshot: vi.fn(),
  handleJavaScriptDialogViaCdp: cdpMocks.handleJavaScriptDialogViaCdp,
  printPdfViaCdp: cdpMocks.printPdfViaCdp,
  setExtraHTTPHeadersViaCdp: cdpMocks.setExtraHTTPHeadersViaCdp,
  snapshotAria: vi.fn(),
}));

vi.mock("../navigation-guard.js", () => ({
  assertBrowserNavigationAllowed: navigationGuardMocks.assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed: navigationGuardMocks.assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy: navigationGuardMocks.withBrowserNavigationPolicy,
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: childProcessMocks.execFile,
  };
});

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
const { registerBrowserAgentDebugRoutes } = await import("./agent.debug.js");
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

function getPdfPostHandler(ssrfPolicy?: unknown) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, {
    state: () => ({ resolved: { ssrfPolicy } }),
  } as never);
  const handler = postHandlers.get("/pdf");
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

function getStoragePostHandler(routePath: string, ssrfPolicy?: unknown) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentStorageRoutes(app, {
    state: () => ({ resolved: { ssrfPolicy } }),
  } as never);
  const handler = postHandlers.get(routePath);
  expect(handler).toBeTypeOf("function");
  return handler;
}

function getDebugPostHandler(routePath: string) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentDebugRoutes(app, {
    state: () => ({ resolved: {} }),
  } as never);
  const handler = postHandlers.get(routePath);
  expect(handler).toBeTypeOf("function");
  return handler;
}

function getDebugGetHandler(routePath: string) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserAgentDebugRoutes(app, {
    state: () => ({ resolved: {} }),
  } as never);
  const handler = getHandlers.get(routePath);
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
    routeState.cdpUrl = "http://127.0.0.1:18800";
    routeState.profileCtx.profile = {
      driver: "existing-session" as const,
      name: "chrome-live",
      chromeMcp: {
        capabilities: {
          diagnostics: true,
          extensions: true,
          extensionMutation: true,
          thirdPartyTools: true,
          thirdPartyToolExecution: true,
          webMcpTools: true,
          webMcpToolExecution: true,
        },
      },
    } as never;
    routeState.profileCtx.ensureTabAvailable.mockClear();
    chromeMcpMocks.analyzeChromeMcpPerformanceInsight.mockClear();
    routeState.profileCtx.listTabs.mockClear();
    chromeMcpMocks.clickChromeMcpCoords.mockClear();
    chromeMcpMocks.clickChromeMcpElement.mockClear();
    chromeMcpMocks.emulateChromeMcpPage.mockClear();
    chromeMcpMocks.executeChromeMcpThirdPartyDeveloperTool.mockClear();
    chromeMcpMocks.executeChromeMcpWebMcpTool.mockClear();
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.fillChromeMcpElement.mockClear();
    chromeMcpMocks.getChromeMcpConsoleMessage.mockClear();
    chromeMcpMocks.getChromeMcpHeapSnapshotClassNodes.mockClear();
    chromeMcpMocks.getChromeMcpHeapSnapshotDetails.mockClear();
    chromeMcpMocks.getChromeMcpHeapSnapshotRetainers.mockClear();
    chromeMcpMocks.getChromeMcpHeapSnapshotSummary.mockClear();
    chromeMcpMocks.getChromeMcpNetworkRequest.mockClear();
    chromeMcpMocks.getChromeMcpTabId.mockClear();
    chromeMcpMocks.handleChromeMcpDialog
      .mockReset()
      .mockRejectedValue(new Error("No open dialog found"));
    chromeMcpMocks.installChromeMcpExtension.mockClear();
    chromeMcpMocks.listChromeMcpExtensions.mockClear();
    chromeMcpMocks.listChromeMcpThirdPartyDeveloperTools.mockClear();
    chromeMcpMocks.listChromeMcpWebMcpTools.mockClear();
    chromeMcpMocks.reloadChromeMcpExtension.mockClear();
    chromeMcpMocks.runChromeMcpLighthouseAudit.mockClear();
    chromeMcpMocks.navigateChromeMcpPage.mockClear();
    chromeMcpMocks.startChromeMcpPerformanceTrace.mockClear();
    chromeMcpMocks.startChromeMcpScreencast.mockClear();
    chromeMcpMocks.stopChromeMcpPerformanceTrace.mockClear();
    chromeMcpMocks.stopChromeMcpScreencast.mockClear();
    chromeMcpMocks.takeChromeMcpHeapSnapshot.mockClear();
    chromeMcpMocks.takeChromeMcpScreenshot.mockClear();
    chromeMcpMocks.takeChromeMcpSnapshot.mockClear();
    chromeMcpMocks.triggerChromeMcpExtensionAction.mockClear();
    chromeMcpMocks.uninstallChromeMcpExtension.mockClear();
    chromeMcpMocks.waitForChromeMcpText.mockClear();
    cdpMocks.handleJavaScriptDialogViaCdp.mockClear();
    cdpMocks.printPdfViaCdp.mockClear();
    cdpMocks.setExtraHTTPHeadersViaCdp.mockClear();
    navigationGuardMocks.assertBrowserNavigationAllowed.mockClear();
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockClear();
    navigationGuardMocks.withBrowserNavigationPolicy.mockClear();
    childProcessMocks.execFile.mockClear();
    childProcessMocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: unknown, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          JSON.stringify({
            streams: [
              {
                codec_name: "vp9",
                width: 640,
                height: 360,
                r_frame_rate: "25/1",
                avg_frame_rate: "25/1",
                nb_read_frames: "42",
              },
            ],
          }),
          "",
        );
        return {} as never;
      },
    );
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

  it("prints existing-session PDFs through CDP", async () => {
    const handler = getPdfPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: {},
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.ok).toBe(true);
    expect(body.path).toBe("/tmp/fake.png");
    expect(body.targetId).toBe("7");
    expect(cdpMocks.printPdfViaCdp).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "7",
      targetUrl: "https://example.com",
    });
  });

  it("checks existing-session PDF URL when SSRF policy is configured", async () => {
    const handler = getPdfPostHandler({ allowPrivateNetwork: false });
    const response = createBrowserRouteResponse();
    await handler?.({ params: {}, query: {}, body: {} }, response.res);

    expect(response.statusCode).toBe(200);
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "https://example.com",
      ssrfPolicy: { allowPrivateNetwork: false },
    });
  });

  it("returns a clear unsupported error when Chrome MCP PDF has no reachable HTTP CDP endpoint", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-cdp-test-"));
    routeState.cdpUrl = "";
    routeState.profileCtx.profile = {
      driver: "existing-session" as const,
      name: "chrome-live",
      userDataDir,
    } as never;
    await fs.writeFile(
      path.join(userDataDir, "DevToolsActivePort"),
      "9\n/devtools/browser/stale\n",
    );
    try {
      const handler = getPdfPostHandler();
      const response = createBrowserRouteResponse();
      await handler?.({ params: {}, query: {}, body: {} }, response.res);

      expect(response.statusCode).toBe(501);
      expect(String(requireRecord(response.body, "response body").error)).toContain(
        "Chrome MCP pipe sessions do not expose HTTP CDP for PDF generation",
      );
      expect(cdpMocks.printPdfViaCdp).not.toHaveBeenCalled();
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
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

  it("supports existing-session networkidle waits with an evaluated readiness predicate", async () => {
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

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.ok).toBe(true);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "7",
        fn: expect.stringContaining("performance.getEntriesByType"),
      }),
    );
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
      timeoutMs: 5000,
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
      timeoutMs: 2000,
    });
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
  });

  it("falls back to direct CDP for active existing-session dialogs when Chrome MCP times out", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset().mockResolvedValue(true as never);
    chromeMcpMocks.handleChromeMcpDialog
      .mockReset()
      .mockRejectedValue(new Error('Chrome MCP "handle_dialog" timed out after 2000ms.'));
    const handler = getDialogHookPostHandler();
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { accept: true, promptText: "approved" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.ok).toBe(true);
    expect(cdpMocks.handleJavaScriptDialogViaCdp).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "7",
      targetUrl: "https://example.com",
      accept: true,
      promptText: "approved",
      ssrfPolicy: undefined,
      timeoutMs: 2000,
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

  it("routes existing-session headers through CDP because Chrome MCP emulate does not support headers", async () => {
    const ssrfPolicy = { allowPrivateNetwork: false, hostnameAllowlist: ["127.0.0.1"] };
    const handler = getStoragePostHandler("/set/headers", ssrfPolicy);
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
    expect(cdpMocks.setExtraHTTPHeadersViaCdp).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "7",
      targetUrl: "https://example.com",
      headers: { "x-openclaw-test": "yes" },
      ssrfPolicy,
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

  it("routes existing-session trace insight analysis through Chrome MCP", async () => {
    const handler = getDebugPostHandler("/trace/insight");
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { insightSetId: "navigation-1", insightName: "LCPBreakdown" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.traceFormat).toBe("chrome-devtools");
    expect(body.insightSetId).toBe("navigation-1");
    expect(body.insightName).toBe("LCPBreakdown");
    expect(chromeMcpMocks.analyzeChromeMcpPerformanceInsight).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
      targetId: "7",
      insightSetId: "navigation-1",
      insightName: "LCPBreakdown",
    });
  });

  it("uses safe defaults for existing-session trace insight analysis", async () => {
    const handler = getDebugPostHandler("/trace/insight");
    const response = createBrowserRouteResponse();

    await handler?.({ params: {}, query: {}, body: {} }, response.res);

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.insightSetId).toBe("navigation-1");
    expect(body.insightName).toBe("DocumentLatency");
    expect(chromeMcpMocks.analyzeChromeMcpPerformanceInsight).toHaveBeenCalledWith(
      expect.objectContaining({
        insightSetId: "navigation-1",
        insightName: "DocumentLatency",
      }),
    );
  });

  it("routes existing-session trace start through Chrome MCP performance trace", async () => {
    const handler = getDebugPostHandler("/trace/start");
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { screenshots: true, snapshots: true },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.traceFormat).toBe("chrome-devtools");
    expect(body.unsupportedPlaywrightTraceOptions).toBe(true);
    expect(chromeMcpMocks.startChromeMcpPerformanceTrace).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
      targetId: "7",
      reload: false,
      autoStop: false,
    });
  });

  it("routes existing-session trace stop through Chrome MCP performance trace", async () => {
    const handler = getDebugPostHandler("/trace/stop");
    const response = createBrowserRouteResponse();

    await handler?.(
      {
        params: {},
        query: {},
        body: { path: "trace-output.json.gz" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    const body = requireRecord(response.body, "response body");
    expect(body.traceFormat).toBe("chrome-devtools");
    expect(String(body.path)).toMatch(/trace-output\.json\.gz$/);
    const params = requireRecord(
      callArg(chromeMcpMocks.stopChromeMcpPerformanceTrace, 0, 0, "trace stop params"),
      "trace stop params",
    );
    expect(params.profileName).toBe("chrome-live");
    expectExistingSessionProfile(params.profile);
    expect(params.targetId).toBe("7");
    expect(String(params.filePath)).toMatch(/trace-output\.json\.gz$/);
  });

  it("routes existing-session heap snapshot debug routes through Chrome MCP", async () => {
    const heapFile = `openclaw-test-heap-${Date.now()}.heapsnapshot`;
    const heapPath = path.join(DEFAULT_TRACE_DIR, heapFile);
    const takeHandler = getDebugPostHandler("/heap-snapshot/take");
    const takeResponse = createBrowserRouteResponse();
    try {
      await takeHandler?.({ params: {}, query: {}, body: { path: heapFile } }, takeResponse.res);

      expect(takeResponse.statusCode).toBe(200);
      expect(chromeMcpMocks.takeChromeMcpHeapSnapshot).toHaveBeenCalledWith({
        profileName: "chrome-live",
        profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
        targetId: "7",
        filePath: heapPath,
        timeoutMs: undefined,
      });

      await fs.writeFile(heapPath, "{}");

      const summaryHandler = getDebugPostHandler("/heap-snapshot/summary");
      await summaryHandler?.(
        { params: {}, query: {}, body: { path: heapFile } },
        createBrowserRouteResponse().res,
      );
      expect(chromeMcpMocks.getChromeMcpHeapSnapshotSummary).toHaveBeenCalledWith({
        profileName: "chrome-live",
        profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
        filePath: heapPath,
        timeoutMs: undefined,
      });

      await getDebugPostHandler("/heap-snapshot/details")?.(
        { params: {}, query: {}, body: { path: heapFile, pageIdx: 1, pageSize: 25 } },
        createBrowserRouteResponse().res,
      );
      expect(chromeMcpMocks.getChromeMcpHeapSnapshotDetails).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: heapPath, pageIdx: 1, pageSize: 25 }),
      );

      await getDebugPostHandler("/heap-snapshot/class-nodes")?.(
        { params: {}, query: {}, body: { path: heapFile, id: 42 } },
        createBrowserRouteResponse().res,
      );
      expect(chromeMcpMocks.getChromeMcpHeapSnapshotClassNodes).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: heapPath, id: 42 }),
      );

      await getDebugPostHandler("/heap-snapshot/retainers")?.(
        { params: {}, query: {}, body: { path: heapFile, nodeId: 99 } },
        createBrowserRouteResponse().res,
      );
      expect(chromeMcpMocks.getChromeMcpHeapSnapshotRetainers).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: heapPath, nodeId: 99 }),
      );
    } finally {
      await fs.rm(heapPath, { force: true });
    }
  });

  it("routes existing-session lighthouse and screencast debug routes through Chrome MCP", async () => {
    const lighthouseDir = `openclaw-test-lh-${Date.now()}`;
    const lighthousePath = path.join(DEFAULT_TRACE_DIR, lighthouseDir);
    await getDebugPostHandler("/lighthouse")?.(
      {
        params: {},
        query: {},
        body: { mode: "snapshot", device: "desktop", outputDirPath: lighthouseDir },
      },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.runChromeMcpLighthouseAudit).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
      targetId: "7",
      mode: "snapshot",
      device: "desktop",
      outputDirPath: lighthousePath,
      timeoutMs: undefined,
    });

    const screencastFile = `openclaw-test-cast-${Date.now()}.webm`;
    const screencastPath = path.join(DEFAULT_TRACE_DIR, screencastFile);
    try {
      await getDebugPostHandler("/screencast/start")?.(
        { params: {}, query: {}, body: { path: screencastFile } },
        createBrowserRouteResponse().res,
      );
      expect(chromeMcpMocks.startChromeMcpScreencast).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "7", filePath: screencastPath }),
      );

      await fs.writeFile(screencastPath, "webm-data");
      const stopResponse = createBrowserRouteResponse();
      await getDebugPostHandler("/screencast/stop")?.(
        { params: {}, query: {}, body: {} },
        stopResponse.res,
      );
      expect(chromeMcpMocks.stopChromeMcpScreencast).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "7" }),
      );
      const stopBody = requireRecord(stopResponse.body, "screencast stop response");
      expect(stopBody.filePath).toBe(screencastPath);
      expect(stopBody.artifactReady).toBe(true);
      expect(stopBody.artifactVideoReady).toBe(true);
      expect(stopBody.artifactBytes).toBeGreaterThan(0);
      expect(stopBody.artifactVideoProbe).toEqual({
        tool: "ffprobe",
        ok: true,
        timeoutMs: 15_000,
        codecName: "vp9",
        width: 640,
        height: 360,
        rFrameRate: "25/1",
        avgFrameRate: "25/1",
        frameCount: 42,
      });
      expect(childProcessMocks.execFile).toHaveBeenCalledWith(
        "ffprobe",
        expect.arrayContaining(["-count_frames", "-select_streams", "v:0", screencastPath]),
        expect.objectContaining({ timeout: 15_000 }),
        expect.any(Function),
      );
    } finally {
      await fs.rm(screencastPath, { force: true });
      await fs.rm(lighthousePath, { force: true, recursive: true });
    }
  });

  it("does not mark Chrome MCP screencasts video-ready when ffprobe cannot decode video", async () => {
    const screencastFile = `openclaw-test-invalid-cast-${Date.now()}.mp4`;
    const screencastPath = path.join(DEFAULT_TRACE_DIR, screencastFile);
    childProcessMocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: unknown, stdout: string, stderr: string) => void,
      ) => {
        const error = Object.assign(new Error("Command failed: ffprobe"), {
          code: 1,
          stderr: "moov atom not found",
        });
        callback(error, "", "moov atom not found");
        return {} as never;
      },
    );
    try {
      await getDebugPostHandler("/screencast/start")?.(
        { params: {}, query: {}, body: { path: screencastFile } },
        createBrowserRouteResponse().res,
      );
      await fs.writeFile(screencastPath, "not-a-real-video");

      const stopResponse = createBrowserRouteResponse();
      await getDebugPostHandler("/screencast/stop")?.(
        { params: {}, query: {}, body: {} },
        stopResponse.res,
      );

      const stopBody = requireRecord(stopResponse.body, "screencast stop response");
      expect(stopBody.filePath).toBe(screencastPath);
      expect(stopBody.artifactExists).toBe(true);
      expect(stopBody.artifactBytes).toBeGreaterThan(0);
      expect(stopBody.artifactReady).toBe(true);
      expect(stopBody.artifactVideoReady).toBe(false);
      expect(String(stopBody.artifactWarning)).toContain("moov atom not found");
      expect(stopBody.artifactVideoProbe).toEqual({
        tool: "ffprobe",
        ok: false,
        timeoutMs: 15_000,
        warning: "moov atom not found",
      });
    } finally {
      await fs.rm(screencastPath, { force: true });
    }
  });

  it("keeps non-empty screencast artifacts file-ready when ffprobe is unavailable", async () => {
    const screencastFile = `openclaw-test-no-ffprobe-cast-${Date.now()}.webm`;
    const screencastPath = path.join(DEFAULT_TRACE_DIR, screencastFile);
    childProcessMocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: unknown, stdout: string, stderr: string) => void,
      ) => {
        const error = Object.assign(new Error("spawn ffprobe ENOENT"), {
          code: "ENOENT",
        });
        callback(error, "", "");
        return {} as never;
      },
    );
    try {
      await getDebugPostHandler("/screencast/start")?.(
        { params: {}, query: {}, body: { path: screencastFile } },
        createBrowserRouteResponse().res,
      );
      await fs.writeFile(screencastPath, "webm-data");

      const stopResponse = createBrowserRouteResponse();
      await getDebugPostHandler("/screencast/stop")?.(
        { params: {}, query: {}, body: {} },
        stopResponse.res,
      );

      const stopBody = requireRecord(stopResponse.body, "screencast stop response");
      expect(stopBody.artifactReady).toBe(true);
      expect(stopBody.artifactVideoReady).toBe(false);
      expect(stopBody.artifactVideoProbe).toEqual({
        tool: "ffprobe",
        ok: false,
        timeoutMs: 15_000,
        warning: "ffprobe is unavailable; cannot validate screencast video frames",
      });
    } finally {
      await fs.rm(screencastPath, { force: true });
    }
  });

  it("clamps custom screencast video probe timeouts for large recordings", async () => {
    const screencastFile = `openclaw-test-timeout-cast-${Date.now()}.webm`;
    const screencastPath = path.join(DEFAULT_TRACE_DIR, screencastFile);
    childProcessMocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: unknown, stdout: string, stderr: string) => void,
      ) => {
        const error = Object.assign(new Error("Command failed: ffprobe"), {
          code: "ETIMEDOUT",
          killed: true,
        });
        callback(error, "", "");
        return {} as never;
      },
    );
    try {
      await getDebugPostHandler("/screencast/start")?.(
        { params: {}, query: {}, body: { path: screencastFile } },
        createBrowserRouteResponse().res,
      );
      await fs.writeFile(screencastPath, "webm-data");

      const stopResponse = createBrowserRouteResponse();
      await getDebugPostHandler("/screencast/stop")?.(
        { params: {}, query: {}, body: { probeTimeoutMs: 120_000 } },
        stopResponse.res,
      );

      const stopBody = requireRecord(stopResponse.body, "screencast stop response");
      expect(stopBody.artifactReady).toBe(true);
      expect(stopBody.artifactVideoReady).toBe(false);
      expect(String(stopBody.artifactWarning)).toContain("higher probeTimeoutMs");
      expect(stopBody.artifactVideoProbe).toEqual({
        tool: "ffprobe",
        ok: false,
        timeoutMs: 60_000,
        timedOut: true,
        warning:
          "ffprobe timed out after 60000ms; retry with a higher probeTimeoutMs for large recordings",
      });
      expect(childProcessMocks.execFile).toHaveBeenCalledWith(
        "ffprobe",
        expect.arrayContaining(["-count_frames", "-select_streams", "v:0", screencastPath]),
        expect.objectContaining({ timeout: 60_000 }),
        expect.any(Function),
      );
    } finally {
      await fs.rm(screencastPath, { force: true });
    }
  });

  it("does not validate a stale screencast path for the active recording", async () => {
    const activeFile = `openclaw-test-active-cast-${Date.now()}.webm`;
    const staleFile = `openclaw-test-stale-cast-${Date.now()}.webm`;
    const activePath = path.join(DEFAULT_TRACE_DIR, activeFile);
    const stalePath = path.join(DEFAULT_TRACE_DIR, staleFile);
    try {
      await getDebugPostHandler("/screencast/start")?.(
        { params: {}, query: {}, body: { path: activeFile } },
        createBrowserRouteResponse().res,
      );
      await fs.writeFile(stalePath, "old-valid-looking-webm");

      const stopResponse = createBrowserRouteResponse();
      await getDebugPostHandler("/screencast/stop")?.(
        { params: {}, query: {}, body: { path: staleFile } },
        stopResponse.res,
      );

      expect(stopResponse.statusCode).toBe(400);
      expect(String(requireRecord(stopResponse.body, "screencast stop error").error)).toContain(
        "does not match the active screencast artifact",
      );
      expect(chromeMcpMocks.stopChromeMcpScreencast).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "7" }),
      );
      expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    } finally {
      await fs.rm(activePath, { force: true });
      await fs.rm(stalePath, { force: true });
    }
  });

  it("retries Chrome MCP screencast probes while the artifact is still flushing", async () => {
    const screencastFile = `openclaw-test-flushing-cast-${Date.now()}.webm`;
    const screencastPath = path.join(DEFAULT_TRACE_DIR, screencastFile);
    childProcessMocks.execFile.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: unknown, stdout: string, stderr: string) => void,
      ) => {
        const error = Object.assign(new Error("Command failed: ffprobe"), {
          code: 1,
          stderr: "File ended prematurely",
        });
        callback(error, "", "File ended prematurely");
        return {} as never;
      },
    );
    try {
      await getDebugPostHandler("/screencast/start")?.(
        { params: {}, query: {}, body: { path: screencastFile } },
        createBrowserRouteResponse().res,
      );
      await fs.writeFile(screencastPath, "webm-data");

      const stopResponse = createBrowserRouteResponse();
      await getDebugPostHandler("/screencast/stop")?.(
        { params: {}, query: {}, body: {} },
        stopResponse.res,
      );

      const stopBody = requireRecord(stopResponse.body, "screencast stop response");
      expect(stopBody.artifactReady).toBe(true);
      expect(stopBody.artifactVideoReady).toBe(true);
      expect(childProcessMocks.execFile).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(screencastPath, { force: true });
    }
  });

  it("does not treat zero ffprobe frame rates as valid screencast evidence", async () => {
    const screencastFile = `openclaw-test-zero-rate-cast-${Date.now()}.webm`;
    const screencastPath = path.join(DEFAULT_TRACE_DIR, screencastFile);
    childProcessMocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: unknown, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          JSON.stringify({
            streams: [
              {
                codec_name: "vp9",
                width: 640,
                height: 360,
                r_frame_rate: "0/0",
                avg_frame_rate: "0/0",
                nb_read_frames: "42",
              },
            ],
          }),
          "",
        );
        return {} as never;
      },
    );
    try {
      await getDebugPostHandler("/screencast/start")?.(
        { params: {}, query: {}, body: { path: screencastFile } },
        createBrowserRouteResponse().res,
      );
      await fs.writeFile(screencastPath, "webm-data");

      const stopResponse = createBrowserRouteResponse();
      await getDebugPostHandler("/screencast/stop")?.(
        { params: {}, query: {}, body: {} },
        stopResponse.res,
      );

      const stopBody = requireRecord(stopResponse.body, "screencast stop response");
      expect(stopBody.artifactReady).toBe(true);
      expect(stopBody.artifactVideoReady).toBe(false);
      expect(String(stopBody.artifactWarning)).toContain("positive frame rate");
      expect(childProcessMocks.execFile).toHaveBeenCalledTimes(3);
    } finally {
      await fs.rm(screencastPath, { force: true });
    }
  });

  it("rejects Chrome MCP artifact paths outside the Browser output root", async () => {
    const lighthouseResponse = createBrowserRouteResponse();
    await getDebugPostHandler("/lighthouse")?.(
      {
        params: {},
        query: {},
        body: { outputDirPath: path.resolve(os.tmpdir(), "openclaw-outside-lh") },
      },
      lighthouseResponse.res,
    );
    expect(lighthouseResponse.statusCode).toBe(400);
    expect(String(requireRecord(lighthouseResponse.body, "lighthouse error").error)).toContain(
      "lighthouse output directory",
    );
    expect(chromeMcpMocks.runChromeMcpLighthouseAudit).not.toHaveBeenCalled();

    const screencastResponse = createBrowserRouteResponse();
    await getDebugPostHandler("/screencast/start")?.(
      {
        params: {},
        query: {},
        body: { path: path.resolve(os.tmpdir(), "openclaw-outside-cast.webm") },
      },
      screencastResponse.res,
    );
    expect(screencastResponse.statusCode).toBe(400);
    expect(String(requireRecord(screencastResponse.body, "screencast error").error)).toContain(
      "screencast directory",
    );
    expect(chromeMcpMocks.startChromeMcpScreencast).not.toHaveBeenCalled();

    const heapResponse = createBrowserRouteResponse();
    await getDebugPostHandler("/heap-snapshot/summary")?.(
      {
        params: {},
        query: {},
        body: { path: path.resolve(os.tmpdir(), "openclaw-outside-heap.heapsnapshot") },
      },
      heapResponse.res,
    );
    expect(heapResponse.statusCode).toBe(400);
    expect(String(requireRecord(heapResponse.body, "heap error").error)).toContain(
      "heap snapshot file",
    );
    expect(chromeMcpMocks.getChromeMcpHeapSnapshotSummary).not.toHaveBeenCalled();

    const requestDetailResponse = createBrowserRouteResponse();
    await getDebugGetHandler("/requests/request")?.(
      {
        params: {},
        query: {
          reqid: "13",
          requestFilePath: path.resolve(os.tmpdir(), "openclaw-outside-request.txt"),
        },
        body: {},
      },
      requestDetailResponse.res,
    );
    expect(requestDetailResponse.statusCode).toBe(400);
    expect(
      String(requireRecord(requestDetailResponse.body, "request detail error").error),
    ).toContain("request detail request body path");
    expect(chromeMcpMocks.getChromeMcpNetworkRequest).not.toHaveBeenCalled();

    const screencastStopResponse = createBrowserRouteResponse();
    await getDebugPostHandler("/screencast/stop")?.(
      {
        params: {},
        query: {},
        body: { path: path.resolve(os.tmpdir(), "openclaw-outside-stop.webm") },
      },
      screencastStopResponse.res,
    );
    expect(screencastStopResponse.statusCode).toBe(400);
    expect(
      String(requireRecord(screencastStopResponse.body, "screencast stop error").error),
    ).toContain("screencast directory");
    expect(chromeMcpMocks.stopChromeMcpScreencast).not.toHaveBeenCalled();
  });

  it("routes existing-session extension debug routes through Chrome MCP", async () => {
    await getDebugGetHandler("/extensions")?.(
      { params: {}, query: {}, body: {} },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.listChromeMcpExtensions).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
      timeoutMs: undefined,
    });

    chromeMcpMocks.listChromeMcpExtensions.mockRejectedValueOnce(
      new Error("Protocol error (Extensions.getExtensions): Method not available."),
    );
    const unavailableResponse = createBrowserRouteResponse();
    await getDebugGetHandler("/extensions")?.(
      { params: {}, query: {}, body: {} },
      unavailableResponse.res,
    );
    expect(unavailableResponse.statusCode).toBe(200);
    const unavailableBody = requireRecord(unavailableResponse.body, "extensions unavailable body");
    expect(unavailableBody.ok).toBe(true);
    expect(unavailableBody.unavailable).toBe(true);
    expect(unavailableBody.extensions).toEqual([]);

    await getDebugPostHandler("/extensions/install")?.(
      { params: {}, query: {}, body: { path: "/tmp/ext" } },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.installChromeMcpExtension).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/tmp/ext" }),
    );

    await getDebugPostHandler("/extensions/reload")?.(
      { params: {}, query: {}, body: { id: "ext-1" } },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.reloadChromeMcpExtension).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ext-1" }),
    );

    await getDebugPostHandler("/extensions/action")?.(
      { params: {}, query: {}, body: { id: "ext-1" } },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.triggerChromeMcpExtensionAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ext-1" }),
    );

    await getDebugPostHandler("/extensions/uninstall")?.(
      { params: {}, query: {}, body: { id: "ext-1" } },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.uninstallChromeMcpExtension).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ext-1" }),
    );

    await getDebugGetHandler("/extensions/tab-id")?.(
      { params: {}, query: {}, body: {} },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.getChromeMcpTabId).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "7" }),
    );
  });

  it("routes existing-session third-party and WebMCP debug routes through Chrome MCP", async () => {
    await getDebugGetHandler("/third-party-tools")?.(
      { params: {}, query: {}, body: {} },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.listChromeMcpThirdPartyDeveloperTools).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "7" }),
    );

    await getDebugPostHandler("/third-party-tools/execute")?.(
      { params: {}, query: {}, body: { toolName: "react", toolParams: { inspect: true } } },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.executeChromeMcpThirdPartyDeveloperTool).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "7", toolName: "react", toolParams: { inspect: true } }),
    );

    await getDebugGetHandler("/web-mcp-tools")?.(
      { params: {}, query: {}, body: {} },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.listChromeMcpWebMcpTools).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "7" }),
    );

    await getDebugPostHandler("/web-mcp-tools/execute")?.(
      { params: {}, query: {}, body: { toolName: "tool", input: { ok: true } } },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.executeChromeMcpWebMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "7", toolName: "tool", input: { ok: true } }),
    );
  });

  it("blocks Chrome MCP mutation and page-tool execution when profile policy disables them", async () => {
    routeState.profileCtx.profile = {
      driver: "existing-session" as const,
      name: "chrome-live",
      chromeMcp: {
        capabilities: {
          diagnostics: true,
          extensions: false,
          extensionMutation: false,
          thirdPartyTools: false,
          thirdPartyToolExecution: false,
          webMcpTools: false,
          webMcpToolExecution: false,
        },
      },
    } as never;

    const extensionListResponse = createBrowserRouteResponse();
    await getDebugGetHandler("/extensions")?.(
      { params: {}, query: {}, body: {} },
      extensionListResponse.res,
    );
    expect(extensionListResponse.statusCode).toBe(403);
    expect(String(requireRecord(extensionListResponse.body, "extensions error").error)).toContain(
      "extensions",
    );
    expect(chromeMcpMocks.listChromeMcpExtensions).not.toHaveBeenCalled();

    const extensionTabResponse = createBrowserRouteResponse();
    await getDebugGetHandler("/extensions/tab-id")?.(
      { params: {}, query: {}, body: {} },
      extensionTabResponse.res,
    );
    expect(extensionTabResponse.statusCode).toBe(403);
    expect(
      String(requireRecord(extensionTabResponse.body, "extension tab id error").error),
    ).toContain("extensions");
    expect(chromeMcpMocks.getChromeMcpTabId).not.toHaveBeenCalled();

    const installResponse = createBrowserRouteResponse();
    await getDebugPostHandler("/extensions/install")?.(
      { params: {}, query: {}, body: { path: "/tmp/ext" } },
      installResponse.res,
    );
    expect(installResponse.statusCode).toBe(403);
    expect(String(requireRecord(installResponse.body, "install error").error)).toContain(
      "extensionMutation",
    );
    expect(chromeMcpMocks.installChromeMcpExtension).not.toHaveBeenCalled();

    const thirdPartyListResponse = createBrowserRouteResponse();
    await getDebugGetHandler("/third-party-tools")?.(
      { params: {}, query: {}, body: {} },
      thirdPartyListResponse.res,
    );
    expect(thirdPartyListResponse.statusCode).toBe(403);
    expect(
      String(requireRecord(thirdPartyListResponse.body, "third-party list error").error),
    ).toContain("thirdPartyTools");
    expect(chromeMcpMocks.listChromeMcpThirdPartyDeveloperTools).not.toHaveBeenCalled();

    const thirdPartyResponse = createBrowserRouteResponse();
    await getDebugPostHandler("/third-party-tools/execute")?.(
      { params: {}, query: {}, body: { toolName: "react" } },
      thirdPartyResponse.res,
    );
    expect(thirdPartyResponse.statusCode).toBe(403);
    expect(String(requireRecord(thirdPartyResponse.body, "third party error").error)).toContain(
      "thirdPartyToolExecution",
    );
    expect(chromeMcpMocks.executeChromeMcpThirdPartyDeveloperTool).not.toHaveBeenCalled();

    const webMcpListResponse = createBrowserRouteResponse();
    await getDebugGetHandler("/web-mcp-tools")?.(
      { params: {}, query: {}, body: {} },
      webMcpListResponse.res,
    );
    expect(webMcpListResponse.statusCode).toBe(403);
    expect(String(requireRecord(webMcpListResponse.body, "webmcp list error").error)).toContain(
      "webMcpTools",
    );
    expect(chromeMcpMocks.listChromeMcpWebMcpTools).not.toHaveBeenCalled();

    const webMcpResponse = createBrowserRouteResponse();
    await getDebugPostHandler("/web-mcp-tools/execute")?.(
      { params: {}, query: {}, body: { toolName: "tool" } },
      webMcpResponse.res,
    );
    expect(webMcpResponse.statusCode).toBe(403);
    expect(String(requireRecord(webMcpResponse.body, "webmcp error").error)).toContain(
      "webMcpToolExecution",
    );
    expect(chromeMcpMocks.executeChromeMcpWebMcpTool).not.toHaveBeenCalled();
  });

  it("blocks Chrome MCP diagnostics before detail or artifact path handling when policy disables them", async () => {
    routeState.profileCtx.profile = {
      driver: "existing-session" as const,
      name: "chrome-live",
      chromeMcp: {
        capabilities: {
          diagnostics: false,
          extensions: true,
          extensionMutation: true,
          thirdPartyTools: true,
          thirdPartyToolExecution: true,
          webMcpTools: true,
          webMcpToolExecution: true,
        },
      },
    } as never;

    const consoleResponse = createBrowserRouteResponse();
    await getDebugGetHandler("/console/message")?.(
      { params: {}, query: { msgid: "12" }, body: {} },
      consoleResponse.res,
    );
    expect(consoleResponse.statusCode).toBe(403);
    expect(String(requireRecord(consoleResponse.body, "console error").error)).toContain(
      "diagnostics",
    );
    expect(chromeMcpMocks.getChromeMcpConsoleMessage).not.toHaveBeenCalled();

    const requestDetailResponse = createBrowserRouteResponse();
    await getDebugGetHandler("/requests/request")?.(
      {
        params: {},
        query: {
          reqid: "13",
          requestFilePath: path.resolve(os.tmpdir(), "openclaw-outside-request.txt"),
        },
        body: {},
      },
      requestDetailResponse.res,
    );
    expect(requestDetailResponse.statusCode).toBe(403);
    expect(
      String(requireRecord(requestDetailResponse.body, "request detail error").error),
    ).toContain("diagnostics");
    expect(chromeMcpMocks.getChromeMcpNetworkRequest).not.toHaveBeenCalled();

    const traceStopResponse = createBrowserRouteResponse();
    await getDebugPostHandler("/trace/stop")?.(
      {
        params: {},
        query: {},
        body: { path: path.resolve(os.tmpdir(), "openclaw-outside-trace.json.gz") },
      },
      traceStopResponse.res,
    );
    expect(traceStopResponse.statusCode).toBe(403);
    expect(String(requireRecord(traceStopResponse.body, "trace stop error").error)).toContain(
      "diagnostics",
    );
    expect(chromeMcpMocks.stopChromeMcpPerformanceTrace).not.toHaveBeenCalled();
  });

  it("routes existing-session console and network detail debug routes through Chrome MCP", async () => {
    await getDebugGetHandler("/console/message")?.(
      { params: {}, query: { msgid: "12" }, body: {} },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.getChromeMcpConsoleMessage).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
      targetId: "7",
      msgid: 12,
    });

    const requestFile = `openclaw-request-${Date.now()}.txt`;
    const requestPath = path.join(DEFAULT_TRACE_DIR, requestFile);
    await getDebugGetHandler("/requests/request")?.(
      { params: {}, query: { reqid: "13", requestFilePath: requestFile }, body: {} },
      createBrowserRouteResponse().res,
    );
    expect(chromeMcpMocks.getChromeMcpNetworkRequest).toHaveBeenCalledWith({
      profileName: "chrome-live",
      profile: expect.objectContaining({ name: "chrome-live", driver: "existing-session" }),
      targetId: "7",
      reqid: 13,
      requestFilePath: requestPath,
      responseFilePath: undefined,
    });
    await fs.rm(requestPath, { force: true });
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
