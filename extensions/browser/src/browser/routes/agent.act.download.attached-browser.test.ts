// Browser tests cover the download route guard for CDP endpoints OpenClaw only attaches to.
// Playwright's download event never fires on such an endpoint (openclaw/openclaw#157547), so both
// download routes must fail fast with an actionable message instead of waiting for the action
// timeout.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isExternallyOwnedCdpEndpoint,
  publishCdpEndpointOwnership,
} from "../cdp-endpoint-ownership.js";
import type { BrowserTab } from "../client.types.js";
import type { ResolvedBrowserProfile } from "../profile.types.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "../server-context.test-harness.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

// Distinct ports keep the module-global ownership registry from leaking across cases; it has no
// reset API.
const EXTERNAL_CDP_PORT = 19512;
const MANAGED_CDP_PORT = 19513;
const EXTERNAL_CDP_URL = `http://127.0.0.1:${EXTERNAL_CDP_PORT}`;
const MANAGED_CDP_URL = `http://127.0.0.1:${MANAGED_CDP_PORT}`;
/** Opaque download request path: output path resolution is mocked in this suite. */
const REQUESTED_DOWNLOAD_PATH = "/tmp/openclaw/downloads/report.pdf";

const outputDirectoryMocks = vi.hoisted(() => ({
  ensureOutputDirectory: vi.fn(async () => {}),
}));

const outputPathMocks = vi.hoisted(() => ({
  resolveWritableOutputPathOrRespond: vi.fn(
    async ({ requestedPath }: { requestedPath: string }) => requestedPath,
  ),
}));

const pwMocks = vi.hoisted(() => ({
  waitForDownloadViaPlaywright: vi.fn(async () => ({
    path: "/tmp/openclaw/downloads/report.pdf",
    suggestedFilename: "report.pdf",
  })),
  downloadViaPlaywright: vi.fn(async () => ({
    path: "/tmp/openclaw/downloads/report.pdf",
    suggestedFilename: "report.pdf",
  })),
}));

// Output writes and Playwright dispatch are the side effects under test; keep both observable
// without touching the downloads root on disk.
vi.mock("../output-directories.js", () => outputDirectoryMocks);
vi.mock("./output-paths.js", () => outputPathMocks);
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => pwMocks),
}));

const { registerBrowserAgentActDownloadRoutes } = await import("./agent.act.download.js");

const unusedProfileOperation = async (): Promise<never> => {
  throw new Error("Unexpected browser profile operation in a download route test");
};

function createDownloadTab(): BrowserTab {
  return {
    targetId: "tab-1",
    type: "page",
    title: "Report",
    url: "http://127.0.0.1:8080/reports",
  };
}

function createRouteContext(profile: ResolvedBrowserProfile) {
  const tab = createDownloadTab();
  const ensureTabAvailable = vi.fn(async () => tab);
  const profileCtx: ProfileContext = {
    profile,
    ensureBrowserAvailable: async () => {},
    ensureTabAvailable,
    isHttpReachable: async () => true,
    isTransportAvailable: async () => true,
    isReachable: async () => true,
    listTabs: async () => [tab],
    openTab: unusedProfileOperation,
    labelTab: unusedProfileOperation,
    focusTab: unusedProfileOperation,
    closeTab: unusedProfileOperation,
    stopRunningBrowser: unusedProfileOperation,
    resetProfile: unusedProfileOperation,
  };
  const context: BrowserRouteContext = {
    ...profileCtx,
    forProfile: () => profileCtx,
    listProfiles: async () => [],
    mapTabError: () => null,
    state: () =>
      makeBrowserServerState({
        profile,
        resolvedOverrides: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } },
      }),
  };
  return { context, ensureTabAvailable };
}

async function callDownloadRoute(params: {
  path: "/wait/download" | "/download";
  body: Record<string, unknown>;
  context: BrowserRouteContext;
}) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActDownloadRoutes(app, params.context);
  const handler = postHandlers.get(params.path);
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: {}, body: params.body }, response.res);
  return response;
}

describe("agent act download routes on an attached browser", () => {
  beforeEach(() => {
    for (const fn of Object.values(outputDirectoryMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(outputPathMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(pwMocks)) {
      fn.mockClear();
    }
  });

  it("rejects download capture on an externally owned endpoint before Playwright or output writes", async () => {
    const profile = makeBrowserProfile({
      name: "attach",
      attachOnly: true,
      cdpPort: EXTERNAL_CDP_PORT,
      cdpUrl: EXTERNAL_CDP_URL,
    });
    publishCdpEndpointOwnership(profile);
    // Fixture sanity: a managed fixture would make both guard assertions vacuous.
    expect(isExternallyOwnedCdpEndpoint(profile.cdpUrl)).toBe(true);
    const { context, ensureTabAvailable } = createRouteContext(profile);

    const waitResponse = await callDownloadRoute({
      path: "/wait/download",
      body: {},
      context,
    });
    expect(waitResponse.statusCode).toBe(501);
    expect(waitResponse.body).toEqual({
      error: expect.stringMatching(/keeps its own download destination/u),
    });

    const downloadResponse = await callDownloadRoute({
      path: "/download",
      body: { ref: "e1", path: REQUESTED_DOWNLOAD_PATH },
      context,
    });
    expect(downloadResponse.statusCode).toBe(501);
    expect(downloadResponse.body).toEqual({
      error: expect.stringMatching(/keeps its own download destination/u),
    });

    expect(ensureTabAvailable).toHaveBeenCalledTimes(2);
    expect(pwMocks.waitForDownloadViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.downloadViaPlaywright).not.toHaveBeenCalled();
    expect(outputDirectoryMocks.ensureOutputDirectory).not.toHaveBeenCalled();
    expect(outputPathMocks.resolveWritableOutputPathOrRespond).not.toHaveBeenCalled();
  });

  it("keeps a managed endpoint on the Playwright download path", async () => {
    const profile = makeBrowserProfile({
      name: "openclaw",
      cdpPort: MANAGED_CDP_PORT,
      cdpUrl: MANAGED_CDP_URL,
    });
    publishCdpEndpointOwnership(profile);
    expect(isExternallyOwnedCdpEndpoint(profile.cdpUrl)).toBe(false);
    const { context } = createRouteContext(profile);

    const waitResponse = await callDownloadRoute({
      path: "/wait/download",
      body: {},
      context,
    });
    expect(waitResponse.statusCode).toBe(200);
    expect(waitResponse.body).toMatchObject({ ok: true, targetId: "tab-1" });
    expect(pwMocks.waitForDownloadViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({ cdpUrl: MANAGED_CDP_URL, targetId: "tab-1" }),
    );
    expect(pwMocks.downloadViaPlaywright).not.toHaveBeenCalled();

    const downloadResponse = await callDownloadRoute({
      path: "/download",
      body: { ref: "e1", path: REQUESTED_DOWNLOAD_PATH },
      context,
    });
    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.body).toMatchObject({ ok: true, targetId: "tab-1" });
    expect(outputDirectoryMocks.ensureOutputDirectory).toHaveBeenCalled();
    expect(pwMocks.downloadViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: MANAGED_CDP_URL,
        ref: "e1",
        path: REQUESTED_DOWNLOAD_PATH,
        targetId: "tab-1",
      }),
    );
  });
});
