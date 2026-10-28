import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createComputerUseRequest,
  expectRequestMethodNotCalled,
  expectSetupErrorStatus,
  expectStatusFields,
  marketplaceEntry,
  requestCalls,
} from "./computer-use.test-support.js";
import {
  createClientHarness,
  useAutoCleanupTempDirTracker,
  waitForHarnessRequest,
} from "./test-support.js";

const sharedClientMocks = vi.hoisted(() => ({
  getLeasedSharedCodexAppServerClient: vi.fn(),
  readCodexAppServerClientDesktopGeneration: vi.fn(),
  readCodexAppServerClientProcessIdentity: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));
const provisioning = vi.hoisted(() => ({
  ensureCodexComputerUseSharedPluginCache: vi.fn(async () => false),
  ensureCodexManagedBundledMarketplace: vi.fn(),
  ensureCodexComputerUseServiceApp: vi.fn(),
  resolveCodexManagedBundledMarketplaceSource: vi.fn(
    async (params: { candidates?: readonly unknown[] }) => params.candidates?.[0],
  ),
  resolveCodexComputerUseServiceAppSourcePath: vi.fn(
    async (params: { sourceAppCandidates?: readonly string[] }) => params.sourceAppCandidates?.[0],
  ),
}));

vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  ...sharedClientMocks,
}));

vi.mock("./computer-use-marketplace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./computer-use-marketplace.js")>()),
  ensureCodexManagedBundledMarketplace: provisioning.ensureCodexManagedBundledMarketplace,
  resolveCodexManagedBundledMarketplaceSource:
    provisioning.resolveCodexManagedBundledMarketplaceSource,
}));

vi.mock("./computer-use-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./computer-use-service.js")>()),
  ensureCodexComputerUseServiceApp: provisioning.ensureCodexComputerUseServiceApp,
  resolveCodexComputerUseServiceAppSourcePath:
    provisioning.resolveCodexComputerUseServiceAppSourcePath,
}));

// mock-isolation: Cache provisioning stays fixture-owned; this suite must not publish a shared cache.
vi.mock("./computer-use-cache.js", () => ({
  ensureCodexComputerUseSharedPluginCache: provisioning.ensureCodexComputerUseSharedPluginCache,
}));

vi.mock("./desktop-app-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./desktop-app-paths.js")>();
  return {
    ...actual,
    resolveMacOSDesktopCodexAppPathCandidates: (platform?: NodeJS.Platform) =>
      actual.resolveMacOSDesktopCodexAppPathCandidates(platform ?? "darwin"),
    resolveMacOSDesktopCodexBundledMarketplaceCandidates: (platform?: NodeJS.Platform) =>
      actual.resolveMacOSDesktopCodexBundledMarketplaceCandidates(platform ?? "darwin"),
  };
});

import {
  ensureCodexComputerUse,
  installCodexComputerUse,
  readCodexComputerUseStatus,
} from "./computer-use.js";

type CodexComputerUseRequest = NonNullable<
  NonNullable<Parameters<typeof ensureCodexComputerUse>[0]>["request"]
>;

const autoInstall = { computerUse: { enabled: true, autoInstall: true } };
const REMOTE_COMPUTER_USE_MARKETPLACE_NAME = "openai-curated-remote";
const REMOTE_COMPUTER_USE_PLUGIN_ID = "plugins~Plugin_00000000000000000000000000000000";
const remoteConfig = {
  computerUse: { enabled: true, marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME },
};

describe("Codex Computer Use setup", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.useRealTimers();
    for (const mock of [...Object.values(sharedClientMocks), ...Object.values(provisioning)]) {
      mock.mockReset();
    }
    provisioning.ensureCodexComputerUseSharedPluginCache.mockResolvedValue(false);
    provisioning.resolveCodexManagedBundledMarketplaceSource.mockImplementation(
      async (params) => params.candidates?.[0],
    );
    provisioning.resolveCodexComputerUseServiceAppSourcePath.mockImplementation(
      async (params) => params.sourceAppCandidates?.[0],
    );
  });

  it("stays disabled before runtime resolution by default", async () => {
    expectStatusFields(await readCodexComputerUseStatus({ pluginConfig: {} }), {
      enabled: false,
      ready: false,
      reason: "disabled",
    });
    await expect(ensureCodexComputerUse({ pluginConfig: {} })).resolves.toMatchObject({
      reason: "disabled",
    });
    expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("runs installation through the readiness thread before releasing the client", async () => {
    const harness = createClientHarness();
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(harness.client);
    const fixture = createComputerUseRequest({ installed: false });
    let cursor = 0;
    const install = installCodexComputerUse({
      pluginConfig: { computerUse: { marketplaceName: "desktop-tools", liveTestTimeoutMs: 150 } },
      agentDir: "/tmp/openclaw-computer-use-guarded-install-agent",
      timeoutMs: 2_000,
    });
    void install.catch(() => undefined);
    for (const method of [
      "experimentalFeature/enablement/set",
      "plugin/list",
      "plugin/read",
      "plugin/install",
      "config/mcpServer/reload",
      "plugin/read",
      "mcpServerStatus/list",
      "thread/start",
      "mcpServer/tool/call",
      "thread/unsubscribe",
    ]) {
      await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(cursor), {
        timeout: 1_000,
      });
      const frame = JSON.parse(harness.writes[cursor++] ?? "{}") as {
        id: number;
        method: string;
        params?: unknown;
      };
      expect(frame.method).toBe(method);
      const result = await fixture(frame.method, frame.params);
      harness.send({ id: frame.id, result: result ?? null });
    }

    await expect(install).resolves.toMatchObject({
      ready: true,
      liveTest: { status: "passed", attempts: 1 },
    });
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(
      harness.client,
    );
    harness.client.close();
  });

  it.each(["abort", "timeout", "stdin", "stdout"] as const)(
    "releases the install lease after a post-write %s failure",
    async (mode) => {
      const harness = createClientHarness();
      const events: string[] = [];
      harness.process.once("exit", () => events.push("exit"));
      try {
        sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(harness.client);
        const agentDir = `/tmp/openclaw-computer-use-${mode}-agent`;
        const abortController = new AbortController();
        const install = installCodexComputerUse({
          pluginConfig: {},
          agentDir,
          timeoutMs: mode === "timeout" ? 150 : 1_000,
          ...(mode === "abort" || mode === "timeout" ? { signal: abortController.signal } : {}),
        });
        await waitForHarnessRequest(harness, "experimentalFeature/enablement/set");

        expect(events).toEqual([]);

        let failureMessage: string;
        if (mode === "stdin" || mode === "stdout") {
          failureMessage = mode === "stdin" ? "write EPIPE" : "stdout pipe broke";
          harness.process[mode].emit("error", new Error(failureMessage));
        } else {
          failureMessage = `experimentalFeature/enablement/set ${mode === "abort" ? "aborted" : "timed out"}`;
          if (mode === "abort") {
            abortController.abort();
          }
        }
        await expect(install).rejects.toThrow(failureMessage);
        expect(harness.stdinDestroyed).toBe(mode === "stdin" || mode === "stdout");
        expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(
          harness.client,
        );
      } finally {
        await harness.client.closeAndWait();
      }
      expect(events).toEqual(["exit"]);
    },
  );

  it("reports an installed but disabled Computer Use plugin separately", async () => {
    const request = createComputerUseRequest({ installed: true, enabled: false });

    const status = await readCodexComputerUseStatus({
      pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "plugin_disabled",
      installed: true,
      pluginEnabled: false,
      mcpServerAvailable: false,
      message:
        "Computer Use is installed, but the computer-use plugin is disabled. Run /codex computer-use install or enable computerUse.autoInstall to re-enable it.",
    });
    expectRequestMethodNotCalled(request, "plugin/install");
  });

  it("fails closed when multiple marketplaces contain Computer Use", async () => {
    const request = createAmbiguousComputerUseRequest();

    const status = await readCodexComputerUseStatus({
      pluginConfig: { computerUse: { enabled: true } },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "marketplace_missing",
      message:
        "Multiple Codex marketplaces contain computer-use. Configure computerUse.marketplaceName or computerUse.marketplacePath to choose one.",
    });
    expectRequestMethodNotCalled(request, "plugin/read");
  });

  it("auto-registers the managed bundled marketplace", async () => {
    const { ensure, request, managedMarketplacePath } = createManagedMarketplaceHarness(
      tempDirs.make("openclaw-codex-bundled-marketplace-"),
    );
    expectStatusFields(await ensure(), {
      ready: true,
      reason: "ready",
      marketplaceName: "openai-bundled",
    });
    expect(request).toHaveBeenCalledWith("marketplace/add", { source: managedMarketplacePath });
  });

  it("migrates the legacy bundled marketplace source through Codex", async () => {
    const { ensure, request, managedMarketplacePath } = createManagedMarketplaceHarness(
      tempDirs.make("openclaw-codex-managed-marketplace-"),
      { configuredSource: "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled" },
    );

    expectStatusFields(await ensure(), {
      ready: true,
      reason: "ready",
      marketplaceName: "openai-bundled",
    });
    expect(
      requestCalls(request)
        .filter(([method]) => method.startsWith("marketplace/"))
        .map(([method, params]) => [method, params]),
    ).toStrictEqual([
      ["marketplace/remove", { marketplaceName: "openai-bundled" }],
      ["marketplace/add", { source: managedMarketplacePath }],
    ]);

    await expect(ensure()).resolves.toMatchObject({ ready: true, reason: "ready" });
    expect(requestCalls(request, "marketplace/remove")).toHaveLength(1);
  });

  it.each([
    ["custom reserved-name source", { configuredSource: "/opt/company/openai-bundled" }],
    ["system-owned legacy source", { configuredSourceOrigin: "system" }],
    ["profile-owned legacy source", { configuredSourceProfile: "work" }],
  ] as const)("preserves %s", async (_label, options) => {
    const { request, ensure } = createManagedMarketplaceHarness(
      tempDirs.make("openclaw-codex-managed-marketplace-"),
      {
        configuredSource: "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled",
        ...options,
      },
    );

    await expect(ensure()).rejects.toThrow("already added from a different source");
    expectRequestMethodNotCalled(request, "marketplace/remove");
  });

  it.each([
    ["default marketplace", {}, true],
    ["marketplace source", { marketplaceSource: "github:example/desktop-tools" }, false],
    [
      "marketplace path",
      { marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json" },
      false,
    ],
  ] as const)(
    "provisions the managed service for a %s explicit desktop install",
    async (_label, selector, provisionsWrapper) => {
      const { agentDir, codexHome, client } = createDesktopInstallClient(
        tempDirs.make("openclaw-codex-explicit-install-"),
      );
      const managedMarketplacePath = path.join(
        codexHome,
        ".tmp/bundled-marketplaces/openai-bundled",
      );
      fs.mkdirSync(managedMarketplacePath, { recursive: true });
      const desktopGeneration = { epoch: 1, fingerprint: "desktop-current" };
      sharedClientMocks.readCodexAppServerClientDesktopGeneration.mockReturnValue(
        desktopGeneration,
      );
      provisioning.ensureCodexManagedBundledMarketplace.mockResolvedValue(managedMarketplacePath);
      provisioning.ensureCodexComputerUseServiceApp.mockResolvedValue(undefined);
      const request = provisionsWrapper
        ? createBundledMarketplaceComputerUseRequest(managedMarketplacePath)
        : createComputerUseRequest({ installed: false });

      const status = await installCodexComputerUse({
        agentDir,
        client,
        request,
        pluginConfig: { computerUse: { enabled: true, autoInstall: false, ...selector } },
      });

      expect(status.ready).toBe(true);
      const owner = expect.objectContaining({
        codexHome,
        ownershipRoot: agentDir,
        appServerCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
      });
      if (provisionsWrapper) {
        expect(provisioning.ensureCodexManagedBundledMarketplace).toHaveBeenCalledWith(owner);
      } else {
        expect(provisioning.ensureCodexManagedBundledMarketplace).not.toHaveBeenCalled();
      }
      expect(provisioning.ensureCodexComputerUseServiceApp).toHaveBeenCalledWith(owner);
      expect(sharedClientMocks.readCodexAppServerClientDesktopGeneration).toHaveReturnedWith(
        desktopGeneration,
      );
      expect(provisioning.ensureCodexComputerUseSharedPluginCache).toHaveBeenCalledWith(
        expect.objectContaining({ forceRefresh: true }),
      );
    },
  );

  it("rejects explicit managed provisioning from a desktop client without a generation", async () => {
    const { agentDir, client } = createDesktopInstallClient(
      tempDirs.make("openclaw-codex-explicit-install-unbound-"),
      "config",
    );

    await expect(
      installCodexComputerUse({
        agentDir,
        client,
        request: vi.fn(),
        pluginConfig: { computerUse: { enabled: true, autoInstall: false } },
      }),
    ).rejects.toThrow("requires a desktop-generation-bound client");
    expect(provisioning.ensureCodexManagedBundledMarketplace).not.toHaveBeenCalled();
  });

  it("requires an explicit install command for configured marketplace sources", async () => {
    const request = createComputerUseRequest({ installed: false });

    await expectSetupErrorStatus(
      ensureCodexComputerUse({
        pluginConfig: {
          computerUse: {
            ...autoInstall.computerUse,
            marketplaceSource: "github:example/desktop-tools",
          },
        },
        request,
      }),
      { reason: "auto_install_blocked" },
    );
    expectRequestMethodNotCalled(request, "marketplace/add", "plugin/install");
  });

  it("fails closed before reading a remote Computer Use plugin without its opaque id", async () => {
    const request = createComputerUseRequest({
      installed: false,
      remoteMarketplace: { name: REMOTE_COMPUTER_USE_MARKETPLACE_NAME, pluginId: null },
    });

    const status = await readCodexComputerUseStatus({ pluginConfig: remoteConfig, request });

    expectStatusFields(status, {
      ready: false,
      reason: "marketplace_missing",
      installed: false,
      pluginEnabled: false,
    });
    expectRequestMethodNotCalled(
      request,
      "plugin/read",
      "plugin/install",
      "experimentalFeature/enablement/set",
    );

    await expectSetupErrorStatus(installCodexComputerUse({ pluginConfig: remoteConfig, request }), {
      ready: false,
      reason: "marketplace_missing",
    });
    expectRequestMethodNotCalled(request, "plugin/read", "plugin/install", "marketplace/add");
  });

  it("prefers the official remote Computer Use marketplace over unrelated matches", async () => {
    const request = createComputerUseRequest({
      installed: false,
      remoteMarketplace: {
        name: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        pluginId: REMOTE_COMPUTER_USE_PLUGIN_ID,
      },
      additionalMarketplaceNames: ["workspace-tools"],
    });

    const status = await installCodexComputerUse({
      pluginConfig: { computerUse: {} },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      remoteMarketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
      pluginName: REMOTE_COMPUTER_USE_PLUGIN_ID,
    });
    expectRequestMethodNotCalled(request, "marketplace/add", "experimentalFeature/list");
  });

  it("waits for the default Codex marketplace during install", async () => {
    vi.useFakeTimers();
    const request = createComputerUseRequest({
      installed: false,
      marketplaceAvailableAfterListCalls: 3,
    });
    const installed = installCodexComputerUse({
      pluginConfig: { computerUse: {} },
      request,
    });

    await vi.advanceTimersByTimeAsync(4_000);

    expectStatusFields(await installed, { ready: true, reason: "ready" });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
    expect(requestCalls(request, "plugin/list")).toHaveLength(3);
  });

  it("fails fast when Codex native plugins are disabled", async () => {
    vi.useFakeTimers();
    const request = createComputerUseRequest({
      installed: false,
      nativePluginsEnabled: false,
      marketplaceAvailableAfterListCalls: Number.POSITIVE_INFINITY,
    });
    const install = installCodexComputerUse({
      pluginConfig: { computerUse: {} },
      request,
    });
    const pending = expectSetupErrorStatus(install, {
      ready: false,
      reason: "marketplace_missing",
      message: expect.stringContaining("features.plugins = false"),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await pending;

    expect(requestCalls(request, "plugin/list")).toHaveLength(1);
    expect(requestCalls(request, "experimentalFeature/list")).toHaveLength(1);
    expectRequestMethodNotCalled(request, "plugin/install");
    await expect(install).rejects.toThrow("/codex computer-use install");
  });
});

function createAmbiguousComputerUseRequest(): CodexComputerUseRequest {
  return vi.fn(async (method: string) => {
    if (method === "plugin/list") {
      return { marketplaces: ["desktop-tools", "other-tools"].map(marketplaceEntry) };
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function createBundledMarketplaceComputerUseRequest(
  bundledMarketplacePath: string,
  options: {
    configuredSource?: string;
    configuredSourceOrigin?: "system" | "user";
    configuredSourceProfile?: string;
  } = {},
): CodexComputerUseRequest {
  const codexHome = path.resolve(bundledMarketplacePath, "../../..");
  let configuredSource = options.configuredSource;
  let registered = configuredSource === bundledMarketplacePath;
  const pluginRequest = createComputerUseRequest({
    installed: false,
    localMarketplace: {
      name: "openai-bundled",
      path: `${bundledMarketplacePath}/.agents/plugins/marketplace.json`,
    },
    probeThreadPrefix: "bundled-marketplace-probe-thread",
  });
  return vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === "config/read") {
      if (!configuredSource) {
        return { config: {}, origins: {} };
      }
      const profile = options.configuredSourceProfile ?? null;
      const name =
        options.configuredSourceOrigin === "system"
          ? { type: "system", file: "/etc/codex/config.toml" }
          : {
              type: "user",
              profile,
              file: path.join(codexHome, profile ? `${profile}.config.toml` : "config.toml"),
            };
      return {
        config: {
          marketplaces: { "openai-bundled": { source_type: "local", source: configuredSource } },
        },
        origins: { "marketplaces.openai-bundled.source": { name } },
      };
    }
    if (method === "marketplace/remove") {
      expect(requestParams).toEqual({ marketplaceName: "openai-bundled" });
      configuredSource = undefined;
      registered = false;
      return { marketplaceName: "openai-bundled" };
    }
    if (method === "marketplace/add") {
      expect(requestParams).toEqual({ source: bundledMarketplacePath });
      if (configuredSource && configuredSource !== bundledMarketplacePath) {
        throw new Error(
          "marketplace 'openai-bundled' is already added from a different source; remove it before adding this source | -32600",
        );
      }
      configuredSource = bundledMarketplacePath;
      registered = true;
      return { marketplaceName: "openai-bundled" };
    }
    if (method === "plugin/list" && !registered) {
      return { marketplaces: [] };
    }
    if (method === "experimentalFeature/list") {
      throw new Error(`unexpected request ${method}`);
    }
    return pluginRequest(method, requestParams);
  }) as CodexComputerUseRequest;
}

function createDesktopInstallClient(root: string, commandSource = "config") {
  const { agentDir, codexHome, client } = createClientHome(root, "0.148.0");
  sharedClientMocks.readCodexAppServerClientProcessIdentity.mockReturnValue({
    clientId: "client-explicit-install",
    command: "/Applications/ChatGPT.app/Contents/Resources/codex",
    commandSource,
    argsFingerprint: "args",
  });
  return { agentDir, codexHome, client };
}

function createManagedMarketplaceHarness(
  root: string,
  options: Parameters<typeof createBundledMarketplaceComputerUseRequest>[1] = {},
) {
  const { agentDir, codexHome, client } = createClientHome(root, "0.149.1");
  const managedMarketplacePath = path.join(codexHome, ".tmp/bundled-marketplaces/openai-bundled");
  fs.mkdirSync(managedMarketplacePath, { recursive: true });
  const request = createBundledMarketplaceComputerUseRequest(managedMarketplacePath, options);
  const ensure = () =>
    ensureCodexComputerUse({ agentDir, client, request, pluginConfig: autoInstall });
  return { agentDir, client, managedMarketplacePath, request, ensure };
}

function createClientHome(root: string, serverVersion: string) {
  const agentDir = path.join(root, "agent");
  const codexHome = path.join(agentDir, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  const client = createClientHarness().client;
  vi.spyOn(client, "getRuntimeIdentity").mockReturnValue({ serverVersion, codexHome });
  return { agentDir, codexHome, client };
}
