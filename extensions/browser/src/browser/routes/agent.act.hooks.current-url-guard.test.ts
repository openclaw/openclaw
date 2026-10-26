import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectResponse, runRoute } from "./agent-route.test-support.js";
import { createBrowserRouteApp } from "./test-helpers.js";

const mcp = vi.hoisted(() => ({
  evaluateChromeMcpScript: vi.fn(async () => true),
  uploadChromeMcpFile: vi.fn(async () => {}),
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
  uploadViaPlaywright: vi.fn(async () => {}),
  clickViaPlaywright: vi.fn(async () => {}),
  setInputFilesViaPlaywright: vi.fn(async () => {}),
}));

// mock-isolation: Observe rejected hook effects without connecting to a live Chrome session.
vi.mock("../chrome-mcp.js", () => mcp);

vi.mock("../paths.js", () => pathMocks);

// mock-isolation: Keep hook effects in the controlled Playwright fixture without loading a browser.
vi.mock("../pw-ai-module.js", () => ({ getPwAiModule: vi.fn(async () => pwMocks) }));

const { registerBrowserAgentActHookRoutes } = await import("./agent.act.hooks.js");

function createProfileContext(options?: {
  attachOnly?: boolean;
  driver?: "openclaw" | "extension" | "existing-session";
}) {
  return {
    profile: {
      attachOnly: options?.attachOnly ?? false,
      cdpIsLoopback: true,
      cdpUrl: "http://127.0.0.1:9222",
      driver: options?.driver ?? ("openclaw" as const),
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

async function callHook(params: {
  path: "/hooks/file-chooser" | "/hooks/dialog";
  body: Record<string, unknown>;
  profileCtx: ReturnType<typeof createProfileContext>;
  allowPrivateNetwork?: boolean;
}) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActHookRoutes(app, {
    forProfile: () => params.profileCtx,
    state: () => ({
      resolved: {
        actionTimeoutMs: 60_000,
        extraArgs: [],
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: params.allowPrivateNetwork === true },
      },
    }),
  } as never);
  return await runRoute(postHandlers.get(params.path), { body: params.body });
}

async function upload(
  profile: Parameters<typeof createProfileContext>[0],
  body: Record<string, unknown> = { paths: ["/tmp/upload.txt"], ref: "upload-button" },
) {
  return await callHook({
    path: "/hooks/file-chooser",
    body,
    profileCtx: createProfileContext(profile),
    allowPrivateNetwork: true,
  });
}

const sideEffects = Object.values({ ...mcp, ...pathMocks, ...pwMocks });

describe("agent act hook current URL guard", () => {
  beforeEach(() => {
    for (const fn of sideEffects) {
      fn.mockClear();
    }
  });

  it.each([
    ["/hooks/file-chooser", { paths: ["/tmp/upload.txt"], ref: "upload-button" }],
    ["/hooks/dialog", { accept: true }],
  ] as const)(
    "blocks %s before page side effects on a disallowed current tab",
    async (path, body) => {
      const response = await callHook({ path, body, profileCtx: createProfileContext() });
      expectResponse(
        response,
        { error: "browser navigation blocked by policy", reason: "navigation_blocked" },
        400,
      );
      for (const sideEffect of sideEffects) {
        expect(sideEffect).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { profile: { driver: "extension" as const }, fallback: true },
    { profile: { attachOnly: true }, fallback: false },
  ])(
    "uploads byte payloads with oversized-path fallback=$fallback",
    async ({ profile, fallback }) => {
      // Store extensions cannot hand off local paths until the payload size cap.
      expectResponse(await upload(profile), { ok: true });
      expect(pwMocks.uploadViaPlaywright).toHaveBeenCalledWith(
        expect.objectContaining({
          browserFilesystemLocal: false,
          uploadPathsFallbackOnPayloadLimit: fallback,
          ref: "upload-button",
          paths: ["/tmp/upload.txt"],
        }),
      );
    },
  );

  it.each([
    { targeting: { ref: "upload-button" }, paths: ["first.txt"] },
    { targeting: { inputRef: "upload-button" }, paths: ["first.txt", "second.txt"] },
  ])("uploads every resolved file through Chrome MCP: $paths", async ({ targeting, paths }) => {
    const resolvedPaths = paths.map((file) => `/tmp/openclaw/uploads/${file}`);
    pathMocks.resolveExistingUploadPaths.mockResolvedValueOnce({ ok: true, paths: resolvedPaths });
    const response = await upload({ driver: "existing-session" }, { paths, ...targeting });

    expectResponse(response, { ok: true });
    expect(mcp.uploadChromeMcpFile).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "tab-1",
        uid: "upload-button",
        filePaths: resolvedPaths,
      }),
    );
  });
});
