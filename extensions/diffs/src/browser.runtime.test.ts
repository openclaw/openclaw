import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginBlobEntry,
  PluginBlobStoreWithReceipts,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDiffsPlugin } from "./plugin.js";
import { createTempDiffRoot } from "./test-helpers.js";

const { launchMock, playwrightExecutablePathMock } = vi.hoisted(() => ({
  launchMock: vi.fn(),
  playwrightExecutablePathMock: vi.fn(),
}));
const toolContext = {
  agentId: "main",
  sessionId: "session-123",
  messageChannel: "discord",
  agentAccountId: "default",
};
const browserConfig: OpenClawConfig = { browser: { executablePath: process.execPath } };

let PlaywrightDiffScreenshotter: typeof import("./browser.runtime.js").PlaywrightDiffScreenshotter;
type ScreenshotParams = Parameters<
  InstanceType<typeof PlaywrightDiffScreenshotter>["screenshotHtml"]
>[0];

vi.mock("playwright-core", () => ({
  chromium: {
    launch: launchMock,
    executablePath: playwrightExecutablePathMock,
  },
}));

afterAll(() => {
  vi.doUnmock("playwright-core");
  vi.resetModules();
});

describe("PlaywrightDiffScreenshotter", () => {
  let rootDir: string;
  let outputPath: string;
  let cleanupRootDir: () => Promise<void>;
  let originalPlatform: PropertyDescriptor;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    originalPlatform = expectDefined(
      Object.getOwnPropertyDescriptor(process, "platform"),
      "process.platform descriptor",
    );
    ({ PlaywrightDiffScreenshotter } = await import("./browser.runtime.js"));
    ({ rootDir, cleanup: cleanupRootDir } = await createTempDiffRoot("openclaw-diffs-browser-"));
    outputPath = path.join(rootDir, "preview.png");
    launchMock.mockReset();
    playwrightExecutablePathMock.mockReset().mockReturnValue(path.join(rootDir, "chromium"));
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await cleanupRootDir();
  });

  function screenshotParams(
    overrides: Partial<Omit<ScreenshotParams, "image">> & {
      image?: Partial<ScreenshotParams["image"]>;
    } = {},
  ): ScreenshotParams {
    return {
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath,
      theme: "dark",
      ...overrides,
      image: {
        format: "png",
        qualityPreset: "standard",
        scale: 2,
        maxWidth: 960,
        maxPixels: 8_000_000,
        ...overrides.image,
      },
    };
  }

  it("uses standard Windows system roots when install-root overrides are blank", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    for (const [key, value] of Object.entries({
      PATH: "",
      OPENCLAW_BROWSER_EXECUTABLE_PATH: "",
      BROWSER_EXECUTABLE_PATH: "",
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "",
      LOCALAPPDATA: " ",
      ProgramFiles: " \t ",
      "ProgramFiles(x86)": "",
    })) {
      vi.stubEnv(key, value);
    }
    vi.spyOn(os, "homedir").mockReturnValue("C:\\Users\\test");
    const accessMock = vi.spyOn(fs, "access").mockRejectedValue(new Error("ENOENT"));

    launchMock.mockResolvedValue(createMockBrowser([]));
    const screenshotter = new PlaywrightDiffScreenshotter({ config: {} });
    await screenshotter.screenshotHtml(screenshotParams({ image: { scale: 1 } }));
    const [options] = expectDefined(launchMock.mock.calls[0], "browser launch");
    expect(options).not.toHaveProperty("executablePath");
    const candidates = accessMock.mock.calls.map(([candidate]) => String(candidate));
    expect(candidates).toEqual([
      "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      playwrightExecutablePathMock(),
    ]);
    expect(candidates.every((candidate) => path.win32.isAbsolute(candidate))).toBe(true);
  });

  it.each([true, false])(
    "renders with Playwright-only installation when full Chromium is present=%s",
    async (hasFullChromium) => {
      vi.stubEnv("PATH", "");
      vi.stubEnv("OPENCLAW_BROWSER_EXECUTABLE_PATH", "");
      vi.stubEnv("BROWSER_EXECUTABLE_PATH", "");
      vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "");
      const managedPath = path.join(rootDir, "playwright", "chromium", "chrome");
      playwrightExecutablePathMock.mockReturnValue(managedPath);
      vi.spyOn(fs, "access").mockImplementation(async (candidate) => {
        if (!hasFullChromium || candidate !== managedPath) {
          throw new Error("ENOENT");
        }
      });

      launchMock.mockResolvedValue(createMockBrowser([]));
      const screenshotter = new PlaywrightDiffScreenshotter({ config: {} });
      await screenshotter.screenshotHtml(screenshotParams({ image: { scale: 1 } }));
      const [launchOptions] = expectDefined(launchMock.mock.calls[0], "browser launch");
      if (hasFullChromium) {
        // Playwright's default headless launch requests the absent shell binary.
        expect(launchOptions.executablePath).toBe(managedPath);
      } else {
        // A shell-only installation must retain Playwright's default selection.
        expect(launchOptions).not.toHaveProperty("executablePath");
      }
      await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("png");
    },
  );

  it("shares a browser across parallel renders and closes it after the idle window", async () => {
    const { pages, browser, screenshotter } = await createScreenshotterHarness();

    await Promise.all([
      screenshotter.screenshotHtml(screenshotParams()),
      screenshotter.screenshotHtml(screenshotParams()),
    ]);

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(2);
    expect(browser.newPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ deviceScaleFactor: 2 }),
    );
    expect(pages).toHaveLength(2);
    expect(pages[0]?.close).toHaveBeenCalledTimes(1);
    expect(pages[1]?.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(browser.close).toHaveBeenCalledTimes(1);

    await screenshotter.screenshotHtml(screenshotParams({ theme: "light" }));

    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it("uses explicit tool config for viewer links and screenshot browser selection", async () => {
    const processConfig: OpenClawConfig = {
      gateway: { publicOrigin: "https://process.example" },
      browser: { executablePath: path.join(rootDir, "unavailable-browser") },
    };
    const explicitConfig: OpenClawConfig = {
      gateway: { publicOrigin: "https://explicit.example" },
      browser: { executablePath: process.execPath },
    };
    const { render } = createRegistrationHarness({}, processConfig);
    launchMock.mockResolvedValue(createMockBrowser([]));

    const { details } = await render({ config: explicitConfig });

    expect
      .soft(String(details.viewerUrl))
      .toContain("https://explicit.example/plugins/diffs/view/");
    expect(details.fileError).toBeUndefined();
    expect(launchMock).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: process.execPath }),
    );
    await expect(fs.readFile(String(details.filePath), "utf8")).resolves.toBe("png");
  });

  it.each([
    ["pdf", 2, 240, 8_000_000, 2, 1],
    ["png", 2, 240, 8_000_000, 2, 1],
    ["png", 4, 1700, 8_000_000, 2.14, 2],
    ["pdf", 2, 60_000, 8_000_000, null, 1],
    ["png", 1, 240, 10, null, 1],
  ] as const)("renders %s at %s", async (format, scale, height, maxPixels, actual, count) => {
    const { pages, screenshotter } = await createScreenshotterHarness({
      boundingBox: { x: 40, y: 40, width: 960, height },
    });
    outputPath = path.join(rootDir, `preview.${format}`);
    const params = screenshotParams({ image: { format, scale, maxPixels } });
    const render = screenshotter.screenshotHtml(params);
    if (actual === null) {
      await expect(render).rejects.toThrow("Diff frame did not render within image size limits.");
    } else {
      expect(await render).toBe(actual);
      await expect(fs.readFile(outputPath, "utf8")).resolves.toBe(
        format === "pdf" ? "%PDF-1.7 mock" : "png",
      );
    }
    expect(pages).toHaveLength(count);
    const page = expectDefined(pages.at(-1), "diffs browser page");
    expect(page.pdf).toHaveBeenCalledTimes(format === "pdf" && actual !== null ? 1 : 0);
    expect(page.screenshot).toHaveBeenCalledTimes(format === "png" && actual !== null ? 1 : 0);
    if (format === "pdf" && actual !== null) {
      expect(page.pdf.mock.calls[0]?.[0]).not.toHaveProperty("pageRanges");
    }
  });

  it.each(["launch", "new-page"])("wraps %s failures with Chromium guidance", async (failure) => {
    const browser = createMockBrowser([]);
    if (failure === "launch") {
      launchMock.mockRejectedValue(new Error("launch failed"));
    } else {
      browser.newPage.mockRejectedValue(new Error("page creation failed"));
      launchMock.mockResolvedValue(browser);
    }
    const screenshotter = new PlaywrightDiffScreenshotter({ config: browserConfig });
    await expect(screenshotter.screenshotHtml(screenshotParams())).rejects.toThrow(
      "requires a Chromium-compatible browser",
    );
  });
});

function createRegistrationHarness(
  pluginConfig: Record<string, unknown> = {},
  initialConfig = createRuntimeConfig(pluginConfig),
) {
  let config = initialConfig;
  const registered: {
    tool?: Parameters<OpenClawPluginApi["registerTool"]>[0];
    toolOptions?: Parameters<OpenClawPluginApi["registerTool"]>[1];
    httpHandler?: Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]["handler"];
  } = {};
  const on = vi.fn();
  const blobStore = createMemoryBlobStore();
  const api = createTestPluginApi({
    id: "diffs",
    config: { gateway: { port: 18789, bind: "loopback" } },
    pluginConfig,
    runtime: {
      config: { current: () => config },
      state: { openBlobStore: () => blobStore },
    } as never,
    registerTool(tool, options) {
      registered.tool = tool;
      registered.toolOptions = options;
    },
    registerHttpRoute(route) {
      registered.httpHandler = route.handler;
    },
    on,
  });
  registerDiffsPlugin(api);
  const registration = expectDefined(registered.tool, "registered diffs tool");
  if (typeof registration !== "function") {
    throw new Error("expected diffs tool factory");
  }
  const handleRequest = expectDefined(registered.httpHandler, "registered diffs HTTP handler");

  return {
    on,
    toolOptions: registered.toolOptions,
    setConfig: (next: OpenClawConfig) => {
      config = next;
    },
    get: async (viewerPath: string, headers?: IncomingMessage["headers"]) => {
      const res = createMockServerResponse();
      expect(await handleRequest(localReq({ method: "GET", url: viewerPath, headers }), res)).toBe(
        true,
      );
      return res;
    },
    render: async (context: OpenClawPluginToolContext = toolContext) => {
      const tool = expectDefined(registration(context), "diffs tool for context");
      if (Array.isArray(tool)) {
        throw new Error("expected one registered diffs tool");
      }
      const result = await tool.execute("tool-1", { before: "one\n", after: "two\n" });
      const details = expectDefined(asOptionalRecord(result.details), "diffs tool details");
      expect(typeof details.viewerPath).toBe("string");
      return { details, viewerPath: String(details.viewerPath) };
    },
  };
}

const STARTUP_DIFFS_DEFAULTS = {
  mode: "view",
  theme: "light",
  background: false,
  layout: "split",
  showLineNumbers: false,
  diffIndicators: "classic",
  lineSpacing: 2,
};

function createRuntimeConfig(config: Record<string, unknown>): OpenClawConfig {
  return {
    gateway: { port: 18789, bind: "loopback" },
    plugins: { entries: { diffs: { config } } },
  };
}

describe("diffs plugin registration", () => {
  it("uses live runtime tool config through the registered tool factory", async () => {
    const startupConfig = {
      viewerBaseUrl: "https://startup.example.com/openclaw",
      defaults: STARTUP_DIFFS_DEFAULTS,
    };
    const { render, get, setConfig } = createRegistrationHarness(startupConfig);

    setConfig(
      createRuntimeConfig({
        viewerBaseUrl: "https://live.example.com/gateway",
        defaults: {
          mode: "view",
          theme: "dark",
          background: true,
          layout: "unified",
          showLineNumbers: true,
          diffIndicators: "bars",
          lineSpacing: 1.6,
        },
      }),
    );

    const { details, viewerPath } = await render({ ...toolContext, sessionId: "session-456" });
    const res = await get(viewerPath);
    expect(String(details.viewerUrl)).toContain("https://live.example.com/gateway");
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('body data-theme="dark"');
    expect(String(res.body)).toContain('"backgroundEnabled":true');
    expect(String(res.body)).toContain('"diffStyle":"unified"');
    expect(String(res.body)).toContain('"disableLineNumbers":false');
    expect(String(res.body)).toContain('"diffIndicators":"bars"');
    expect(String(res.body)).toContain("--diffs-line-height: 24px;");
  });

  it("uses live runtime viewer-access config through the registered HTTP handler", async () => {
    const { on, toolOptions, render, get, setConfig } = createRegistrationHarness(
      { defaults: STARTUP_DIFFS_DEFAULTS, security: { allowRemoteViewer: true } },
      createRuntimeConfig({ security: { allowRemoteViewer: true } }),
    );

    // Guidance rides the tool registration, so a run that denies `diffs` gets none.
    expect(on).not.toHaveBeenCalled();
    expect(toolOptions?.name).toBe("diffs");
    expect(toolOptions?.promptGuidance).toContain("prefer the `diffs` tool");
    // Guidance is gated on `diffs` alone, so it cannot require optional message/canvas tools.
    expect(toolOptions?.promptGuidance).not.toMatch(/\bmessage\b|\bcanvas\b/i);

    const { details, viewerPath } = await render();
    const res = await get(viewerPath);
    expect(res.statusCode).toBe(200);
    expect(details.context).toEqual(toolContext);

    setConfig(createRuntimeConfig({ security: { allowRemoteViewer: false } }));

    const proxiedRes = await get(viewerPath, { "x-forwarded-for": "203.0.113.10" });
    expect(proxiedRes.statusCode).toBe(404);
  });

  it("fails closed for remote viewer access when the live diffs plugin entry is removed", async () => {
    const { render, get, setConfig } = createRegistrationHarness({
      security: { allowRemoteViewer: true },
    });

    const { viewerPath } = await render({ ...toolContext, sessionId: "session-789" });

    setConfig({ ...createRuntimeConfig({}), plugins: { entries: {} } });

    const proxiedRes = await get(viewerPath, { "x-forwarded-for": "203.0.113.10" });
    expect(proxiedRes.statusCode).toBe(404);
  });
});

function createMemoryBlobStore<TMetadata>(): PluginBlobStoreWithReceipts<TMetadata> {
  const entries = new Map<string, PluginBlobEntry<TMetadata>>();
  const read = (key: string): PluginBlobEntry<TMetadata> | undefined => {
    const entry = entries.get(key);
    if (!entry || (entry.expiresAt !== undefined && entry.expiresAt <= Date.now())) {
      entries.delete(key);
      return undefined;
    }
    return { ...entry, bytes: entry.bytes.slice() };
  };
  const register = (
    key: string,
    bytes: Uint8Array,
    metadata: TMetadata,
    opts?: { ttlMs?: number },
  ) => {
    const createdAt = Date.now();
    const receipt = { createdAt, ...(opts?.ttlMs ? { expiresAt: createdAt + opts.ttlMs } : {}) };
    entries.set(key, {
      key,
      sizeBytes: bytes.byteLength,
      bytes: bytes.slice(),
      metadata,
      ...receipt,
    });
    return receipt;
  };
  const info = ({ bytes: _bytes, ...entry }: PluginBlobEntry<TMetadata>) => entry;
  const deleteExpiredKey = async (key: string) => {
    const entry = entries.get(key);
    if (!entry || entry.expiresAt === undefined || entry.expiresAt > Date.now()) {
      return undefined;
    }
    entries.delete(key);
    return info(entry);
  };
  return {
    async register(key, bytes, metadata, opts) {
      register(key, bytes, metadata, opts);
    },
    async registerIfAbsent(key, bytes, metadata, opts) {
      if (read(key)) {
        return false;
      }
      register(key, bytes, metadata, opts);
      return true;
    },
    async registerIfAbsentWithReceipt(key, bytes, metadata, opts) {
      return read(key) ? undefined : register(key, bytes, metadata, opts);
    },
    async lookup(key) {
      return read(key);
    },
    async entries() {
      return [...entries.keys()].flatMap((key) => {
        const entry = read(key);
        return entry ? [info(entry)] : [];
      });
    },
    async delete(key) {
      return entries.delete(key);
    },
    deleteExpiredKey,
    async deleteExpired() {
      const expired = [];
      for (const key of entries.keys()) {
        const entry = await deleteExpiredKey(key);
        if (entry) {
          expired.push(entry);
        }
      }
      return expired;
    },
    async clear() {
      entries.clear();
    },
  };
}

function localReq(input: {
  method: string;
  url: string;
  headers?: IncomingMessage["headers"];
}): IncomingMessage {
  return {
    ...input,
    headers: input.headers ?? {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

async function createScreenshotterHarness(options?: Parameters<typeof createMockPage>[0]) {
  const pages: Array<ReturnType<typeof createMockPage>> = [];
  const browser = createMockBrowser(pages, options);
  launchMock.mockResolvedValue(browser);
  const screenshotter = new PlaywrightDiffScreenshotter({ config: browserConfig });
  return { pages, browser, screenshotter };
}

function createMockBrowser(
  pages: Array<ReturnType<typeof createMockPage>>,
  options?: Parameters<typeof createMockPage>[0],
) {
  return {
    newPage: vi.fn(async (pageOptions?: { deviceScaleFactor?: number }) => {
      const page = createMockPage({
        ...options,
        deviceScaleFactor: pageOptions?.deviceScaleFactor,
      });
      pages.push(page);
      return page;
    }),
    close: vi.fn(async () => {}),
    on: vi.fn(),
  };
}

function createMockPage(options?: {
  boundingBox?: { x: number; y: number; width: number; height: number };
  deviceScaleFactor?: number;
}) {
  const box = options?.boundingBox ?? { x: 40, y: 40, width: 640, height: 240 };
  const writer = (contents: string) =>
    vi.fn(async ({ path: output }: { path: string }) => {
      await fs.writeFile(output, contents);
    });

  return {
    route: vi.fn(async () => {}),
    setContent: vi.fn(async () => {}),
    waitForFunction: vi.fn(async () => {}),
    evaluate: vi.fn(async () => options?.deviceScaleFactor ?? 1),
    emulateMedia: vi.fn(async () => {}),
    locator: vi.fn(() => ({
      waitFor: vi.fn(async () => {}),
      boundingBox: vi.fn(async () => box),
    })),
    setViewportSize: vi.fn(async () => {}),
    screenshot: writer("png"),
    pdf: writer("%PDF-1.7 mock"),
    close: vi.fn(async () => {}),
  };
}
