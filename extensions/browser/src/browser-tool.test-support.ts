import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, vi } from "vitest";
import type { BrowserActionPathResult } from "./browser/client-actions-types.js";

const { mockResult, defaultBrowserConfig, downloadResult, observation } = vi.hoisted(() => ({
  mockResult: <T>(factory: () => T) => vi.fn(async (..._args: unknown[]) => factory()),
  observation: <T>(payload: T) => ({ ok: true, targetId: "t1", ...payload }),
  defaultBrowserConfig: () => ({
    enabled: true,
    controlPort: 18791,
    profiles: {},
    defaultProfile: "openclaw",
    actionTimeoutMs: 60_000,
  }),
  downloadResult: (filename: string) => ({
    ok: true,
    targetId: "tab-1",
    download: {
      path: `/tmp/openclaw/downloads/${filename}`,
    },
  }),
}));

function routeBrowserClientMocks(
  actual: Record<string, (...args: never[]) => unknown>,
  mocks: Record<string, (...args: never[]) => unknown>,
) {
  // Delegated requests retain the production client projection before the mocked Gateway.
  return Object.fromEntries(
    Object.entries(mocks).map(([name, local]) => [
      name,
      (...args: unknown[]) =>
        Reflect.apply(typeof args[0] === "function" ? actual[name]! : local, undefined, args),
    ]),
  );
}

const browserClientMocks = vi.hoisted(() => ({
  browserCloseTab: mockResult(() => ({})),
  browserDoctor: mockResult(() => ({ ok: true })),
  browserFocusTab: mockResult(() => ({})),
  browserImportProfile: mockResult(() => ({ ok: true })),
  browserOpenTab: mockResult(() => ({})),
  browserProfiles: mockResult<Array<Record<string, unknown>>>(() => []),
  browserSystemProfiles: mockResult<Array<Record<string, unknown>>>(() => []),
  browserSnapshot: mockResult<Record<string, unknown>>(() =>
    observation({ format: "ai", url: "https://example.com", snapshot: "ok" }),
  ),
  browserStart: mockResult(() => ({})),
  browserStatus: mockResult(() => ({ ok: true, running: true })),
  browserStop: mockResult(() => ({})),
  browserTabs: mockResult<{ running: true; tabs: Array<Record<string, unknown>> }>(() => ({
    running: true,
    tabs: [],
  })),
}));
vi.mock("./browser/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browser/client.js")>();
  return { ...actual, ...routeBrowserClientMocks(actual, browserClientMocks) };
});

const browserActionsMocks = vi.hoisted(() => ({
  browserAct: vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true })),
  browserArmDialog: vi.fn(async () => ({ ok: true })),
  browserArmFileChooser: vi.fn(async () => ({ ok: true })),
  browserConsoleMessages: vi.fn(async () =>
    observation({
      messages: new Array<{ type: string; text: string; timestamp: string }>(),
    }),
  ),
  browserRequests: mockResult<Record<string, unknown>>(() => observation({ requests: [] })),
  browserErrors: mockResult<Record<string, unknown>>(() => observation({ errors: [] })),
  browserPageText: mockResult<Record<string, unknown>>(() =>
    observation({ text: "Page prose", truncated: false }),
  ),
  browserEmulateSetting: vi.fn(async (..._args: unknown[]) => ({ ok: true, targetId: "t1" })),
  browserNavigate: vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true })),
  browserDownload: vi.fn(async () => downloadResult("report.pdf")),
  browserPdfSave: vi.fn(async () => ({ ok: true, path: "/tmp/test.pdf" })),
  browserScreenshotAction: mockResult<BrowserActionPathResult>(() => ({
    ok: true,
    path: "/tmp/test.png",
    targetId: "tab-1",
  })),
  browserWaitForDownload: vi.fn(async () => downloadResult("export.csv")),
}));
vi.mock("./browser/client-actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browser/client-actions.js")>();
  return { ...actual, ...routeBrowserClientMocks(actual, browserActionsMocks) };
});

const browserConfigMocks = vi.hoisted(() => ({
  resolveBrowserConfig: vi.fn(defaultBrowserConfig),
  resolveProfile: vi.fn((resolved: Record<string, unknown>, name: string) => {
    const profile = (resolved.profiles as Record<string, Record<string, unknown>> | undefined)?.[
      name
    ];
    if (!profile) {
      return null;
    }
    const driver = profile.driver === "existing-session" ? "existing-session" : "openclaw";
    const existing = driver === "existing-session";
    return {
      name,
      driver,
      cdpPort: existing ? 0 : typeof profile.cdpPort === "number" ? profile.cdpPort : 18792,
      cdpUrl: existing
        ? ""
        : typeof profile.cdpUrl === "string"
          ? profile.cdpUrl
          : "http://127.0.0.1:18792",
      cdpHost: existing ? "" : "127.0.0.1",
      cdpIsLoopback: true,
      color: typeof profile.color === "string" ? profile.color : "#FF4500",
      attachOnly: existing || profile.attachOnly === true,
    };
  }),
}));
vi.mock("./browser/config.js", () => browserConfigMocks);

const browserHostAvailabilityMocks = vi.hoisted(() => ({
  isBrowserHostAvailable: vi.fn<(_config: OpenClawConfig, _profileName?: string) => boolean>(
    () => false,
  ),
}));
vi.mock("./browser-host-availability.js", () => browserHostAvailabilityMocks);

const nodesUtilsMocks = vi.hoisted(() => ({
  listNodes: vi.fn(async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => []),
}));

const gatewayMocks = vi.hoisted(() => ({
  readGatewayToolOperatorScopes: vi.fn<() => readonly string[] | undefined>(() => undefined),
  hasGatewayToolRoutingContext: vi.fn(() => true),
  callGatewayTool: vi.fn(async (): Promise<Record<string, unknown>> => ({
    ok: true,
    payload: { result: { ok: true, running: true } },
  })),
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn<
    () => {
      browser: Record<string, unknown>;
      gateway?: OpenClawConfig["gateway"];
      agents?: { defaults?: { imageMaxDimensionPx?: number } };
    }
  >(() => ({ browser: {} })),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: configMocks.loadConfig,
}));

const pathValidationMocks = vi.hoisted(() => ({
  resolveExistingUploadPaths: vi.fn<typeof import("./browser/paths.js").resolveExistingUploadPaths>(
    async ({ requestedPaths }) => ({ ok: true, paths: requestedPaths }),
  ),
}));

const sessionTabRegistryMocks = vi.hoisted(() => ({
  touchSessionBrowserTab: vi.fn(),
  trackSessionBrowserTab: vi.fn(),
  untrackSessionBrowserTab: vi.fn(),
}));
vi.mock("./browser/session-tab-registry.js", () => sessionTabRegistryMocks);

const toolCommonMocks = vi.hoisted(() => ({
  fetchBrowserJson: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
    ok: true,
    running: true,
    source: "gateway-host",
  })),
  imageResultFromFile:
    vi.fn<typeof import("openclaw/plugin-sdk/channel-actions").imageResultFromFile>(),
  describeImageFile: vi.fn(async () => ({ text: undefined, decision: { outcome: "skipped" } })),
  stageBrowserScreenshotForSharing: vi.fn(async () => "/tmp/openclaw-media/outbound/share.png"),
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: gatewayMocks.callGatewayTool,
  readGatewayToolOperatorScopes: gatewayMocks.readGatewayToolOperatorScopes,
  hasGatewayToolRoutingContext: gatewayMocks.hasGatewayToolRoutingContext,
  listNodes: nodesUtilsMocks.listNodes,
}));
vi.mock("openclaw/plugin-sdk/channel-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-actions")>()),
  imageResultFromFile: toolCommonMocks.imageResultFromFile,
}));
vi.mock("openclaw/plugin-sdk/media-understanding-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding-runtime")>()),
  describeImageFile: toolCommonMocks.describeImageFile,
}));

vi.mock("./browser/client-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/client-fetch.js")>()),
  fetchBrowserJson: toolCommonMocks.fetchBrowserJson,
}));
vi.mock("./browser/proxy-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/proxy-files.js")>()),
  persistBrowserProxyResultFiles: vi.fn(async (result: unknown) => result),
}));
vi.mock("./browser/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/paths.js")>()),
  resolveExistingUploadPaths: pathValidationMocks.resolveExistingUploadPaths,
}));
vi.mock("./browser/screenshot-sharing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/screenshot-sharing.js")>()),
  stageBrowserScreenshotForSharing: toolCommonMocks.stageBrowserScreenshotForSharing,
}));

export function mockSingleBrowserProxyNode() {
  nodesUtilsMocks.listNodes.mockResolvedValue([
    {
      nodeId: "node-1",
      displayName: "Browser Node",
      connected: true,
      caps: ["browser"],
      commands: ["browser.proxy", "browser.proxy.upload.v1"],
    },
  ]);
}

export function resetBrowserToolMocks() {
  vi.clearAllMocks();
  gatewayMocks.hasGatewayToolRoutingContext.mockReturnValue(true);
  gatewayMocks.readGatewayToolOperatorScopes.mockReturnValue(undefined);
  browserHostAvailabilityMocks.isBrowserHostAvailable.mockReset().mockReturnValue(false);
  configMocks.loadConfig.mockReturnValue({ browser: {} });
  browserConfigMocks.resolveBrowserConfig.mockReturnValue(defaultBrowserConfig());
  nodesUtilsMocks.listNodes.mockResolvedValue([]);
  toolCommonMocks.describeImageFile.mockResolvedValue({
    text: undefined,
    decision: { outcome: "skipped" },
  });
  toolCommonMocks.stageBrowserScreenshotForSharing.mockResolvedValue(
    "/tmp/openclaw-media/outbound/share.png",
  );
  toolCommonMocks.fetchBrowserJson.mockReset().mockResolvedValue({
    ok: true,
    running: true,
    source: "gateway-host",
  });
  toolCommonMocks.imageResultFromFile.mockReset().mockImplementation(async (params) => ({
    content: [
      ...(params.extraText ? [{ type: "text" as const, text: params.extraText }] : []),
      { type: "image", data: "base64", mimeType: "image/png" },
    ],
    details: { path: params.path, ...params.details },
  }));
}

export function registerBrowserToolAfterEachReset() {
  beforeEach(resetBrowserToolMocks);
  afterEach(resetBrowserToolMocks);
}

export {
  browserActionsMocks,
  browserClientMocks,
  browserConfigMocks,
  browserHostAvailabilityMocks,
  configMocks,
  gatewayMocks,
  nodesUtilsMocks,
  pathValidationMocks,
  sessionTabRegistryMocks,
  toolCommonMocks,
};
