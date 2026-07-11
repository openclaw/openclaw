// Browser tests cover agent.act hook current-tab navigation guard behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toBrowserErrorResponse } from "../errors.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const chromeMcpMocks = vi.hoisted(() => ({
  evaluateChromeMcpScript: vi.fn(async () => true),
  uploadChromeMcpFile: vi.fn(async () => {}),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationResultAllowed: vi.fn(async (_opts?: { url: string }) => {}),
  withBrowserNavigationPolicy: vi.fn(
    (ssrfPolicy?: unknown, opts?: { browserProxyMode?: string }) => ({
      ...(ssrfPolicy ? { ssrfPolicy } : {}),
      ...(opts?.browserProxyMode ? { browserProxyMode: opts.browserProxyMode } : {}),
    }),
  ),
}));

const pathMocks = vi.hoisted(() => ({
  resolveExistingUploadPaths: vi.fn(async ({ requestedPaths }: { requestedPaths: string[] }) => ({
    ok: true,
    paths: requestedPaths,
  })),
}));

const pwMocks = vi.hoisted(() => ({
  armDialogViaPlaywright: vi.fn(async () => {}),
  armFileUploadViaPlaywright: vi.fn(async () => {}),
  clickViaPlaywright: vi.fn(async () => {}),
  setInputFilesViaPlaywright: vi.fn(async () => {}),
}));

vi.mock("../chrome-mcp.js", () => ({
  evaluateChromeMcpScript: chromeMcpMocks.evaluateChromeMcpScript,
  uploadChromeMcpFile: chromeMcpMocks.uploadChromeMcpFile,
}));

vi.mock("../navigation-guard.js", () => navigationGuardMocks);

vi.mock("../paths.js", () => pathMocks);

vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => pwMocks),
}));

const { registerBrowserAgentActHookRoutes } = await import("./agent.act.hooks.js");

function createProfileContext() {
  return {
    profile: {
      cdpIsLoopback: true,
      cdpUrl: "http://127.0.0.1:9222",
      driver: "openclaw" as const,
      name: "default",
    },
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "tab-1",
      title: "Internal Admin",
      url: "http://127.0.0.1:8080/admin",
      type: "page",
    })),
    listTabs: vi.fn(async () => []),
  };
}

function createRouteContext(profileCtx: ReturnType<typeof createProfileContext>) {
  return {
    forProfile: () => profileCtx,
    mapTabError: vi.fn(toBrowserErrorResponse),
    state: () => ({
      resolved: {
        actionTimeoutMs: 60_000,
        extraArgs: [],
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      },
    }),
  };
}

async function callHook(params: {
  path: "/hooks/file-chooser" | "/hooks/dialog";
  body: Record<string, unknown>;
  profileCtx: ReturnType<typeof createProfileContext>;
}) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActHookRoutes(app, createRouteContext(params.profileCtx) as never);
  const handler = postHandlers.get(params.path);
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.(
    {
      params: {},
      query: {},
      body: params.body,
    },
    response.res,
  );
  return response;
}

function rejectCurrentTabUrl() {
  navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(async () => {
    const error = new Error("blocked current tab");
    error.name = "InvalidBrowserNavigationUrlError";
    throw error;
  });
}

describe("agent act hook current URL guard", () => {
  beforeEach(() => {
    for (const fn of Object.values(chromeMcpMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(pathMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(pwMocks)) {
      fn.mockClear();
    }
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockReset();
    navigationGuardMocks.withBrowserNavigationPolicy.mockClear();
  });

  it("blocks file chooser hooks before page side effects on a disallowed current tab", async () => {
    rejectCurrentTabUrl();
    const profileCtx = createProfileContext();

    const response = await callHook({
      path: "/hooks/file-chooser",
      body: { paths: ["/tmp/upload.txt"], ref: "upload-button" },
      profileCtx,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "blocked current tab" });
    expect(profileCtx.ensureTabAvailable).toHaveBeenCalledOnce();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8080/admin",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    });
    expect(pathMocks.resolveExistingUploadPaths).not.toHaveBeenCalled();
    expect(chromeMcpMocks.uploadChromeMcpFile).not.toHaveBeenCalled();
    expect(pwMocks.armFileUploadViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.clickViaPlaywright).not.toHaveBeenCalled();
    expect(pwMocks.setInputFilesViaPlaywright).not.toHaveBeenCalled();
  });

  it("blocks dialog hooks before page side effects on a disallowed current tab", async () => {
    rejectCurrentTabUrl();
    const profileCtx = createProfileContext();

    const response = await callHook({
      path: "/hooks/dialog",
      body: { accept: true },
      profileCtx,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "blocked current tab" });
    expect(profileCtx.ensureTabAvailable).toHaveBeenCalledOnce();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8080/admin",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    });
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalled();
    expect(pwMocks.armDialogViaPlaywright).not.toHaveBeenCalled();
  });
});
