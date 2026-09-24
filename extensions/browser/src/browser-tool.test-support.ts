import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, vi } from "vitest";
import type { BrowserActionPathResult } from "./browser/client-actions-types.js";

const browserClientMocks = vi.hoisted(() => ({
  browserCloseTab: vi.fn(async (..._args: unknown[]) => ({})),
  browserDoctor: vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    profile: "openclaw",
    transport: "cdp",
    checks: [],
    status: {
      enabled: true,
      running: true,
      pid: 1,
      cdpPort: 18792,
      cdpUrl: "http://127.0.0.1:18792",
    },
  })),
  browserFocusTab: vi.fn(async (..._args: unknown[]) => ({})),
  browserImportProfile: vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    systemProfile: "Default",
    into: "imported",
    browser: "chrome",
    cookies: { total: 1, imported: 1, failed: 0, skipped: 0 },
    domains: [".example.com"],
  })),
  browserOpenTab: vi.fn(async (..._args: unknown[]) => ({})),
  browserProfiles: vi.fn(
    async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => [],
  ),
  browserSystemProfiles: vi.fn(
    async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => [],
  ),
  browserSnapshot: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
    ok: true,
    format: "ai",
    targetId: "t1",
    url: "https://example.com",
    snapshot: "ok",
  })),
  browserStart: vi.fn(async (..._args: unknown[]) => ({})),
  browserStatus: vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    running: true,
    pid: 1,
    cdpPort: 18792,
    cdpUrl: "http://127.0.0.1:18792",
  })),
  browserStop: vi.fn(async (..._args: unknown[]) => ({})),
  browserTabs: vi.fn(
    async (
      ..._args: unknown[]
    ): Promise<{ running: true; tabs: Array<Record<string, unknown>> }> => ({
      running: true,
      tabs: [],
    }),
  ),
}));
vi.mock("./browser/client.js", () => browserClientMocks);

const browserActionsMocks = vi.hoisted(() => ({
  browserAct: vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true })),
  browserArmDialog: vi.fn(async () => ({ ok: true })),
  browserArmFileChooser: vi.fn(async () => ({ ok: true })),
  browserConsoleMessages: vi.fn(async () => ({
    ok: true,
    targetId: "t1",
    messages: [
      {
        type: "log",
        text: "Hello",
        timestamp: new Date().toISOString(),
      },
    ],
  })),
  browserRequests: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
    ok: true,
    targetId: "t1",
    requests: [],
  })),
  browserErrors: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
    ok: true,
    targetId: "t1",
    errors: [],
  })),
  browserPageText: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
    ok: true,
    targetId: "t1",
    text: "Page prose",
    truncated: false,
  })),
  browserEmulateSetting: vi.fn(async (..._args: unknown[]) => ({ ok: true, targetId: "t1" })),
  browserNavigate: vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true })),
  browserDownload: vi.fn(async () => ({
    ok: true,
    targetId: "tab-1",
    download: {
      path: "/tmp/openclaw/downloads/report.pdf",
      suggestedFilename: "report.pdf",
      url: "https://example.com/report.pdf",
    },
  })),
  browserPdfSave: vi.fn(async () => ({ ok: true, path: "/tmp/test.pdf" })),
  browserScreenshotAction: vi.fn(async (..._args: unknown[]): Promise<BrowserActionPathResult> => ({
    ok: true,
    path: "/tmp/test.png",
    targetId: "tab-1",
  })),
  browserWaitForDownload: vi.fn(async () => ({
    ok: true,
    targetId: "tab-1",
    download: {
      path: "/tmp/openclaw/downloads/export.csv",
      suggestedFilename: "export.csv",
      url: "https://example.com/export.csv",
    },
  })),
}));
vi.mock("./browser/client-actions.js", () => browserActionsMocks);

const browserConfigMocks = vi.hoisted(() => ({
  resolveBrowserConfig: vi.fn(() => ({
    enabled: true,
    controlPort: 18791,
    profiles: {},
    defaultProfile: "openclaw",
    actionTimeoutMs: 60_000,
  })),
  resolveProfile: vi.fn((resolved: Record<string, unknown>, name: string) => {
    const profile = (resolved.profiles as Record<string, Record<string, unknown>> | undefined)?.[
      name
    ];
    if (!profile) {
      return null;
    }
    const driver = profile.driver === "existing-session" ? "existing-session" : "openclaw";
    if (driver === "existing-session") {
      return {
        name,
        driver,
        cdpPort: 0,
        cdpUrl: "",
        cdpHost: "",
        cdpIsLoopback: true,
        color: typeof profile.color === "string" ? profile.color : "#FF4500",
        attachOnly: true,
      };
    }
    return {
      name,
      driver,
      cdpPort: typeof profile.cdpPort === "number" ? profile.cdpPort : 18792,
      cdpUrl: typeof profile.cdpUrl === "string" ? profile.cdpUrl : "http://127.0.0.1:18792",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      color: typeof profile.color === "string" ? profile.color : "#FF4500",
      attachOnly: profile.attachOnly === true,
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
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: configMocks.loadConfig,
  };
});

const pathValidationMocks = vi.hoisted(() => ({
  resolveExistingUploadPaths: vi.fn<
    (args: {
      requestedPaths: string[];
    }) => Promise<{ ok: true; paths: string[] } | { ok: false; error: string }>
  >(async ({ requestedPaths }) => ({
    ok: true as const,
    paths: requestedPaths,
  })),
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
  normalizeBrowserScreenshot: vi.fn(async (buffer: Buffer) => ({ buffer })),
  saveMediaBuffer: vi.fn(async () => ({ path: "/tmp/openclaw-media/resized.jpg" })),
  stageBrowserScreenshotForSharing: vi.fn(async () => "/tmp/openclaw-media/outbound/share.png"),
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: gatewayMocks.callGatewayTool,
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
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  saveMediaBuffer: toolCommonMocks.saveMediaBuffer,
}));

vi.mock("./browser-tool.runtime.js", async () => {
  const { BrowserToolOutputSchema, createBrowserToolSchema, resolveBrowserToolCapabilities } =
    await vi.importActual<typeof import("./browser-tool.schema.js")>("./browser-tool.schema.js");
  const actualClient =
    await vi.importActual<typeof import("./browser/client.js")>("./browser/client.js");
  const actualActions = await vi.importActual<typeof import("./browser/client-actions.js")>(
    "./browser/client-actions.js",
  );
  const actualMethods: Record<string, (...args: never[]) => unknown> = {
    ...actualClient,
    ...actualActions,
  };
  // Node requests exercise the shared client projection before reaching the mocked Gateway.
  const routedClients = Object.fromEntries(
    Object.entries({ ...browserClientMocks, ...browserActionsMocks }).map(([name, local]) => [
      name,
      (...args: unknown[]) =>
        Reflect.apply(
          typeof args[0] === "function" ? actualMethods[name]! : local,
          undefined,
          args,
        ),
    ]),
  );
  const { wrapExternalContent } = await vi.importActual<
    typeof import("openclaw/plugin-sdk/security-runtime")
  >("openclaw/plugin-sdk/security-runtime");
  const readRawStringValue = (value: unknown) => (typeof value === "string" ? value : undefined);
  const normalizeMockOptionalString = (value: unknown) =>
    readRawStringValue(value)?.trim() || undefined;
  const readStringParam = (
    params: Record<string, unknown>,
    key: string,
    opts?: { required?: boolean; label?: string },
  ) => {
    const value = readRawStringValue(params[key])?.trim();
    if (value) {
      return value;
    }
    if (opts?.required) {
      throw new Error(`${opts.label ?? key} required`);
    }
    return undefined;
  };

  return {
    DEFAULT_AI_SNAPSHOT_MAX_CHARS: 40_000,
    DEFAULT_UPLOAD_DIR: "/tmp/openclaw-browser-uploads",
    BrowserToolOutputSchema,
    createBrowserToolSchema,
    resolveBrowserToolCapabilities,
    ...routedClients,
    ...browserConfigMocks,
    ...configMocks,
    ...gatewayMocks,
    ...sessionTabRegistryMocks,
    fetchBrowserJson: toolCommonMocks.fetchBrowserJson,
    getRuntimeConfig: configMocks.loadConfig,
    resolveRuntimeImageSanitization: () => {
      const configured = configMocks.loadConfig().agents?.defaults?.imageMaxDimensionPx;
      return typeof configured === "number" && Number.isFinite(configured)
        ? { maxDimensionPx: Math.max(1, Math.floor(configured)) }
        : undefined;
    },
    getBrowserProfileCapabilities: (profile: Record<string, unknown>) => {
      const existingSession = profile.driver === "existing-session";
      return {
        usesChromeMcp: existingSession,
        supportsBatchActions: !existingSession,
        supportsDownloads: !existingSession,
        supportsPdf: !existingSession,
        supportsRequests: !existingSession,
        supportsErrors: !existingSession,
        supportsPageText: !existingSession,
        supportsEmulation: !existingSession,
      };
    },
    describeImageFile: toolCommonMocks.describeImageFile,
    saveMediaBuffer: toolCommonMocks.saveMediaBuffer,
    stageBrowserScreenshotForSharing: toolCommonMocks.stageBrowserScreenshotForSharing,
    imageResultFromFile: toolCommonMocks.imageResultFromFile,
    jsonResult: (result: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      details: result,
    }),
    listNodes: nodesUtilsMocks.listNodes,
    normalizeOptionalString: normalizeMockOptionalString,
    persistBrowserProxyResultFiles: vi.fn(async (result: unknown) => result),
    readPositiveIntegerParam: (
      params: Record<string, unknown>,
      key: string,
      options?: { message?: string },
    ) => {
      const raw = params[key];
      if (raw == null) {
        return undefined;
      }
      const value =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && /^\d+$/.test(raw.trim())
            ? Number(raw.trim())
            : undefined;
      if (value === undefined || !Number.isInteger(value) || value <= 0) {
        throw new Error(options?.message ?? `${key} must be a positive integer`);
      }
      return value;
    },
    readStringParam,
    readStringValue: readRawStringValue,
    resolveExistingUploadPaths: pathValidationMocks.resolveExistingUploadPaths,
    resolveNodeIdFromList: (nodes: Array<Record<string, unknown>>, requested: string) => {
      const node = nodes.find(
        (entry) => entry.nodeId === requested || entry.displayName === requested,
      );
      if (!node?.nodeId || typeof node.nodeId !== "string") {
        throw new Error(`Node not found: ${requested}`);
      }
      return node.nodeId;
    },
    selectDefaultNodeFromList: (nodes: Array<Record<string, unknown>>) => nodes[0] ?? null,
    wrapExternalContent,
  };
});

export function resetBrowserToolMocks() {
  vi.clearAllMocks();
  gatewayMocks.hasGatewayToolRoutingContext.mockReturnValue(true);
  gatewayMocks.readGatewayToolOperatorScopes.mockReturnValue(undefined);
  browserHostAvailabilityMocks.isBrowserHostAvailable.mockReset().mockReturnValue(false);
  configMocks.loadConfig.mockReturnValue({ browser: {} });
  browserConfigMocks.resolveBrowserConfig.mockReturnValue({
    enabled: true,
    controlPort: 18791,
    profiles: {},
    defaultProfile: "openclaw",
    actionTimeoutMs: 60_000,
  });
  nodesUtilsMocks.listNodes.mockResolvedValue([]);
  toolCommonMocks.describeImageFile.mockResolvedValue({
    text: undefined,
    decision: { outcome: "skipped" },
  });
  toolCommonMocks.normalizeBrowserScreenshot.mockImplementation(async (buffer: Buffer) => ({
    buffer,
  }));
  toolCommonMocks.saveMediaBuffer.mockResolvedValue({ path: "/tmp/openclaw-media/resized.jpg" });
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
  beforeEach(() => {
    resetBrowserToolMocks();
  });
  afterEach(() => {
    resetBrowserToolMocks();
  });
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
