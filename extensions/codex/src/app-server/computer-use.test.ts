import fs from "node:fs";
import path from "node:path";
// Codex tests cover computer use plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createComputerUseRequest,
  expectRequestMethodNotCalled,
  expectSetupErrorStatus,
  expectStatusFields,
  marketplaceEntry,
  pluginSummary,
  requestCalls,
} from "./computer-use.test-support.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import { resolveCodexNativeConfigFenceKey } from "./shared-client.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./test-support.js";

const sharedClientMocks = vi.hoisted(() => ({
  assertCodexAppServerClientStartSelectionCurrent: vi.fn(),
  getLeasedSharedCodexAppServerClient: vi.fn(),
  readCodexAppServerClientDesktopGeneration: vi.fn(),
  readCodexAppServerClientProcessIdentity: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  waitForCodexAppServerClientDesktopGenerationDrain: vi.fn(),
}));
const managedProvisioningMocks = vi.hoisted(() => ({
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
  ensureCodexManagedBundledMarketplace:
    managedProvisioningMocks.ensureCodexManagedBundledMarketplace,
  resolveCodexManagedBundledMarketplaceSource:
    managedProvisioningMocks.resolveCodexManagedBundledMarketplaceSource,
}));

vi.mock("./computer-use-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./computer-use-service.js")>()),
  ensureCodexComputerUseServiceApp: managedProvisioningMocks.ensureCodexComputerUseServiceApp,
  resolveCodexComputerUseServiceAppSourcePath:
    managedProvisioningMocks.resolveCodexComputerUseServiceAppSourcePath,
}));

vi.mock("./computer-use-cache.js", () => ({
  ensureCodexComputerUseSharedPluginCache:
    managedProvisioningMocks.ensureCodexComputerUseSharedPluginCache,
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

const REMOTE_COMPUTER_USE_MARKETPLACE_NAME = "openai-curated-remote";
const REMOTE_COMPUTER_USE_PLUGIN_ID = "plugins~Plugin_00000000000000000000000000000000";

describe("Codex Computer Use setup", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.useRealTimers();
    sharedClientMocks.assertCodexAppServerClientStartSelectionCurrent.mockReset();
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.readCodexAppServerClientDesktopGeneration.mockReset();
    sharedClientMocks.readCodexAppServerClientProcessIdentity.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain.mockReset();
    sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain.mockResolvedValue(
      undefined,
    );
    managedProvisioningMocks.ensureCodexManagedBundledMarketplace.mockReset();
    managedProvisioningMocks.ensureCodexComputerUseServiceApp.mockReset();
    managedProvisioningMocks.ensureCodexComputerUseSharedPluginCache.mockReset();
    managedProvisioningMocks.ensureCodexComputerUseSharedPluginCache.mockResolvedValue(false);
    managedProvisioningMocks.resolveCodexManagedBundledMarketplaceSource.mockReset();
    managedProvisioningMocks.resolveCodexManagedBundledMarketplaceSource.mockImplementation(
      async (params: { candidates?: readonly unknown[] }) => params.candidates?.[0],
    );
    managedProvisioningMocks.resolveCodexComputerUseServiceAppSourcePath.mockReset();
    managedProvisioningMocks.resolveCodexComputerUseServiceAppSourcePath.mockImplementation(
      async (params: { sourceAppCandidates?: readonly string[] }) =>
        params.sourceAppCandidates?.[0],
    );
  });

  it.each([
    { name: "default", pluginConfig: {} },
    {
      name: "disabled with invalid runtime",
      pluginConfig: { computerUse: { enabled: false }, appServer: { command: "codex app-server" } },
    },
  ])("stays disabled before runtime resolution ($name)", async ({ pluginConfig }) => {
    const status = await readCodexComputerUseStatus({ pluginConfig });
    expectStatusFields(status, {
      enabled: false,
      ready: false,
      reason: "disabled",
      message: "Computer Use is disabled.",
    });
    await expect(ensureCodexComputerUse({ pluginConfig })).resolves.toMatchObject({
      reason: "disabled",
    });
    expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("starts one-off Computer Use setup with the desktop app owner", async () => {
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockRejectedValueOnce(
      new Error("captured start options"),
    );
    const config = { agents: { list: [{ id: "worker" }] } };
    const agentDir = "/tmp/openclaw-worker-agent";

    await expect(installCodexComputerUse({ pluginConfig: {}, config, agentDir })).rejects.toThrow(
      "captured start options",
    );
    expect(sharedClientMocks.getLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(
      expect.objectContaining({
        startOptions: expect.objectContaining({
          commandSource: "managed",
          managedCommandOrder: "desktop-first",
        }),
        config,
        agentDir,
      }),
    );
  });

  it("holds the Codex-home fence until an install request settles", async () => {
    const agentDir = "/tmp/openclaw-computer-use-fence-agent";
    let rejectInstallRequest: (error: Error) => void = () => undefined;
    const request = vi.fn(
      async () =>
        await new Promise((_resolve, reject) => {
          rejectInstallRequest = reject;
        }),
    );
    const client = {
      request,
      closeAndRunAfterExit: vi.fn(),
      getRuntimeIdentity: vi.fn(() => undefined),
    };
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(client);
    const install = installCodexComputerUse({ pluginConfig: {}, agentDir });
    const rejectedInstall = expect(install).rejects.toThrow("stop install");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    const startOptions = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {},
      managedCommandOrder: "desktop-first",
    }).start;
    const fenceKey = resolveCodexNativeConfigFenceKey({ startOptions, agentDir });
    expect(fenceKey).toBeTypeOf("string");
    let contenderAcquired = false;
    const contender = (async () => {
      const release = await acquireCodexNativeConfigFence(fenceKey as string);
      contenderAcquired = true;
      release();
    })();
    await Promise.resolve();
    expect(contenderAcquired).toBe(false);

    rejectInstallRequest(new Error("stop install"));
    await rejectedInstall;
    await contender;
    expect(contenderAcquired).toBe(true);
    expect(client.closeAndRunAfterExit).not.toHaveBeenCalled();
    expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(client);
  });

  it("releases the install mutation fence before the guarded readiness thread", async () => {
    const agentDir = "/tmp/openclaw-computer-use-guarded-install-agent";
    const pluginConfig = {
      computerUse: { marketplaceName: "desktop-tools", liveTestTimeoutMs: 150 },
    };
    const startOptions = resolveCodexAppServerRuntimeOptions({
      pluginConfig,
      managedCommandOrder: "desktop-first",
    }).start;
    const fenceKey = resolveCodexNativeConfigFenceKey({ startOptions, agentDir });
    expect(fenceKey).toBeTypeOf("string");

    const harness = createClientHarness();
    harness.client.setThreadSessionRequestGuard((options) =>
      acquireCodexNativeConfigFence(fenceKey as string, options),
    );
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(harness.client);
    const fixture = createComputerUseRequest({ installed: false });
    let cursor = 0;
    const readFrame = async (method: string) => {
      await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(cursor), {
        timeout: 1_000,
      });
      const frame = JSON.parse(harness.writes[cursor++] ?? "{}") as {
        id: number;
        method: string;
        params?: unknown;
      };
      expect(frame.method).toBe(method);
      return frame;
    };
    const answerFrame = async (frame: { id: number; method: string; params?: unknown }) => {
      const result = await fixture(frame.method, frame.params);
      harness.send({ id: frame.id, result: result ?? null });
    };
    const answer = async (method: string) => answerFrame(await readFrame(method));

    const install = installCodexComputerUse({ pluginConfig, agentDir, timeoutMs: 2_000 });
    void install.catch(() => undefined);
    await answer("experimentalFeature/enablement/set");
    await answer("plugin/list");
    await answer("plugin/read");
    const mutation = await readFrame("plugin/install");
    await expect(
      acquireCodexNativeConfigFence(fenceKey as string, {
        timeoutMs: 10,
        timeoutMessage: "mutation fence held",
      }),
    ).rejects.toThrow("mutation fence held");
    await answerFrame(mutation);
    await answer("config/mcpServer/reload");
    await answer("plugin/read");
    await answer("mcpServerStatus/list");
    await answer("thread/start");
    await answer("mcpServer/tool/call");
    await answer("thread/unsubscribe");

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
    "holds the install fence through process exit after a post-write %s failure",
    async (mode) => {
      const harness = createClientHarness();
      sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValueOnce(harness.client);
      const agentDir = `/tmp/openclaw-computer-use-${mode}-agent`;
      const abortController = new AbortController();
      const install = installCodexComputerUse({
        pluginConfig: {},
        agentDir,
        timeoutMs: mode === "timeout" ? 150 : 1_000,
        ...(mode === "abort" || mode === "timeout" ? { signal: abortController.signal } : {}),
      });
      await vi.waitFor(() => {
        const methods = harness.writes.map(
          (line) => (JSON.parse(line) as { method?: string }).method,
        );
        expect(methods).toContain("experimentalFeature/enablement/set");
      });

      const startOptions = resolveCodexAppServerRuntimeOptions({
        pluginConfig: {},
        managedCommandOrder: "desktop-first",
      }).start;
      const fenceKey = resolveCodexNativeConfigFenceKey({ startOptions, agentDir });
      expect(fenceKey).toBeTypeOf("string");
      const events: string[] = [];
      harness.process.once("exit", () => events.push("exit"));
      const contender = acquireCodexNativeConfigFence(fenceKey as string).then((release) => {
        events.push("fence");
        return release;
      });
      await Promise.resolve();
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
      const releaseContender = await contender;
      try {
        expect(harness.stdinDestroyed).toBe(true);
        expect(events).toEqual(["exit", "fence"]);
        expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(
          harness.client,
        );
      } finally {
        releaseContender();
      }
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

  it("installs Computer Use from a configured marketplace source", async () => {
    const request = createComputerUseRequest({ installed: false });

    const status = await installCodexComputerUse({
      pluginConfig: {
        computerUse: {
          marketplaceSource: "github:example/desktop-tools",
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      installed: true,
      pluginEnabled: true,
      tools: ["list_apps"],
    });
    expect(request).toHaveBeenCalledWith("experimentalFeature/enablement/set", {
      enablement: { plugins: true },
    });
    expect(request).toHaveBeenCalledWith("marketplace/add", {
      source: "github:example/desktop-tools",
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
    expect(request).toHaveBeenCalledWith("config/mcpServer/reload", undefined);
  });

  it("requires explicit install commands to finish with a passing live test", async () => {
    const request = createComputerUseRequest({ installed: true, liveTestFailures: 2 });

    await expectSetupErrorStatus(
      installCodexComputerUse({
        pluginConfig: { computerUse: { marketplaceName: "desktop-tools" } },
        request,
      }),
      {
        ready: false,
        reason: "live_test_failed",
        installed: true,
        pluginEnabled: true,
        mcpServerAvailable: true,
      },
    );
  });

  it("re-enables an installed but disabled Computer Use plugin during install", async () => {
    const request = createComputerUseRequest({ installed: true, enabled: false });

    const status = await installCodexComputerUse({
      pluginConfig: { computerUse: { marketplaceName: "desktop-tools" } },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      installed: true,
      pluginEnabled: true,
      message: "Computer Use is ready.",
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
  });

  it("fails closed when Computer Use is required but not installed", async () => {
    const request = createComputerUseRequest({ installed: false });

    await expectSetupErrorStatus(
      ensureCodexComputerUse({
        pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
        request,
      }),
      {
        reason: "plugin_not_installed",
      },
    );
    expectRequestMethodNotCalled(request, "plugin/install");
  });

  it("skips setup writes when auto-install is already ready", async () => {
    const request = createComputerUseRequest({ installed: true });

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          autoInstall: true,
          marketplaceName: "desktop-tools",
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      message: "Computer Use is ready.",
    });
    expectRequestMethodNotCalled(request, "marketplace/add");
    expectRequestMethodNotCalled(request, "experimentalFeature/enablement/set");
    expectRequestMethodNotCalled(request, "plugin/install");
  });

  it.each([true, false])(
    "auto-registers the first installed bundled marketplace (ChatGPT installed: %s)",
    async (chatGptInstalled) => {
      const root = tempDirs.make("openclaw-codex-bundled-marketplace-");
      const bundledPath = (appName: string) =>
        path.join(
          root,
          "Applications",
          appName,
          "Contents",
          "Resources",
          "plugins",
          "openai-bundled",
        );
      const chatGptMarketplacePath = bundledPath("ChatGPT.app");
      const legacyCodexMarketplacePath = bundledPath("Codex.app");
      if (chatGptInstalled) {
        fs.mkdirSync(chatGptMarketplacePath, { recursive: true });
      }
      fs.mkdirSync(legacyCodexMarketplacePath, { recursive: true });
      const selectedPath = chatGptInstalled ? chatGptMarketplacePath : legacyCodexMarketplacePath;
      const request = createBundledMarketplaceComputerUseRequest(selectedPath);

      const status = await ensureCodexComputerUse({
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        request,
        defaultBundledMarketplacePathCandidates: [
          chatGptMarketplacePath,
          legacyCodexMarketplacePath,
        ],
      });

      expectStatusFields(status, {
        ready: true,
        reason: "ready",
        marketplaceName: "openai-bundled",
        message: "Computer Use is ready.",
      });
      expect(request).toHaveBeenCalledWith("marketplace/add", { source: selectedPath });
    },
  );

  it("keeps explicit bundled marketplace test overrides authoritative during auto-install", async () => {
    const bundledMarketplacePath = tempDirs.make("openclaw-codex-bundled-marketplace-");
    const request = createBundledMarketplaceComputerUseRequest(bundledMarketplacePath);

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          autoInstall: true,
        },
      },
      request,
      defaultBundledMarketplacePath: bundledMarketplacePath,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      marketplaceName: "openai-bundled",
      message: "Computer Use is ready.",
    });
    expect(request).toHaveBeenCalledWith("marketplace/add", {
      source: bundledMarketplacePath,
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: `${bundledMarketplacePath}/.agents/plugins/marketplace.json`,
      pluginName: "computer-use",
    });
  });

  it.each([
    "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled",
    "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled",
  ])("migrates the legacy bundled marketplace source through Codex", async (legacySource) => {
    const { agentDir, client, managedMarketplacePath } = createManagedMarketplaceHarness(
      tempDirs.make("openclaw-codex-managed-marketplace-"),
    );
    const request = createBundledMarketplaceComputerUseRequest(managedMarketplacePath, {
      configuredSource: legacySource,
    });

    const status = await ensureCodexComputerUse({
      agentDir,
      client,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      request,
    });

    expectStatusFields(status, {
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

    await expect(
      ensureCodexComputerUse({
        agentDir,
        client,
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        request,
      }),
    ).resolves.toMatchObject({ ready: true, reason: "ready" });
    expect(
      requestCalls(request).filter(([method]) => method === "marketplace/remove"),
    ).toHaveLength(1);
  });

  it.each([
    {
      label: "a custom source using the reserved bundled marketplace name",
      options: { configuredSource: "/opt/company/openai-bundled" },
    },
    {
      label: "a legacy source owned by a non-user config layer",
      options: {
        configuredSource: "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled",
        configuredSourceOrigin: "system" as const,
      },
    },
    {
      label: "a legacy source owned by a selected user profile",
      options: {
        configuredSource: "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled",
        configuredSourceProfile: "work",
      },
    },
  ])("preserves $label", async ({ options }) => {
    const { agentDir, client, managedMarketplacePath } = createManagedMarketplaceHarness(
      tempDirs.make("openclaw-codex-managed-marketplace-"),
    );
    const request = createBundledMarketplaceComputerUseRequest(managedMarketplacePath, options);

    await expect(
      ensureCodexComputerUse({
        agentDir,
        client,
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        request,
      }),
    ).rejects.toThrow("already added from a different source");
    expectRequestMethodNotCalled(request, "marketplace/remove");
  });

  it.each([
    {
      label: "config-selected default marketplace",
      selector: {},
      provisionsWrapper: true,
    },
    {
      label: "configured marketplace source",
      selector: { marketplaceSource: "github:example/desktop-tools" },
      provisionsWrapper: false,
    },
    {
      label: "configured marketplace path",
      selector: {
        marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      },
      provisionsWrapper: false,
    },
    {
      label: "configured marketplace name",
      selector: { marketplaceName: "desktop-tools" },
      provisionsWrapper: false,
    },
  ])(
    "provisions the managed service for a $label explicit desktop install",
    async ({ selector, provisionsWrapper }) => {
      const { agentDir, codexHome, client } = createDesktopInstallClient(
        tempDirs.make("openclaw-codex-explicit-install-"),
      );
      const managedMarketplacePath = path.join(
        codexHome,
        ".tmp",
        "bundled-marketplaces",
        "openai-bundled",
      );
      fs.mkdirSync(managedMarketplacePath, { recursive: true });
      const desktopGeneration = { epoch: 1, fingerprint: "desktop-current" };
      sharedClientMocks.readCodexAppServerClientDesktopGeneration.mockReturnValue(
        desktopGeneration,
      );
      managedProvisioningMocks.ensureCodexManagedBundledMarketplace.mockResolvedValue(
        managedMarketplacePath,
      );
      managedProvisioningMocks.ensureCodexComputerUseServiceApp.mockResolvedValue({
        status: "already_current",
        changed: false,
      });
      let drainedBeforeFence = false;
      sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain.mockImplementationOnce(
        async () => {
          const release = await acquireCodexNativeConfigFence(
            `codex-home:${path.resolve(codexHome)}`,
            { timeoutMs: 50 },
          );
          drainedBeforeFence = true;
          release();
        },
      );
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
      expect(drainedBeforeFence).toBe(true);
      if (provisionsWrapper) {
        expect(managedProvisioningMocks.ensureCodexManagedBundledMarketplace).toHaveBeenCalledWith(
          expect.objectContaining({
            codexHome,
            ownershipRoot: agentDir,
            appServerCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
          }),
        );
      } else {
        expect(
          managedProvisioningMocks.ensureCodexManagedBundledMarketplace,
        ).not.toHaveBeenCalled();
      }
      expect(managedProvisioningMocks.ensureCodexComputerUseServiceApp).toHaveBeenCalledWith(
        expect.objectContaining({
          codexHome,
          ownershipRoot: agentDir,
          appServerCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
        }),
      );
      expect(sharedClientMocks.assertCodexAppServerClientStartSelectionCurrent).toHaveBeenCalled();
      expect(
        sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain,
      ).toHaveBeenCalledWith({ client, timeoutMs: expect.any(Number) });
      expect(
        sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain.mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        (provisionsWrapper
          ? managedProvisioningMocks.ensureCodexManagedBundledMarketplace.mock
              .invocationCallOrder[0]
          : managedProvisioningMocks.ensureCodexComputerUseServiceApp.mock
              .invocationCallOrder[0]) ?? Number.POSITIVE_INFINITY,
      );
      expect(sharedClientMocks.readCodexAppServerClientDesktopGeneration).toHaveReturnedWith(
        desktopGeneration,
      );
      expect(managedProvisioningMocks.ensureCodexComputerUseSharedPluginCache).toHaveBeenCalledWith(
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
    expect(
      sharedClientMocks.waitForCodexAppServerClientDesktopGenerationDrain,
    ).not.toHaveBeenCalled();
    expect(managedProvisioningMocks.ensureCodexManagedBundledMarketplace).not.toHaveBeenCalled();
  });

  it("rejects explicit provisioning from a stale desktop client", async () => {
    const { agentDir, client } = createDesktopInstallClient(
      tempDirs.make("openclaw-codex-explicit-install-stale-"),
      "resolved-managed",
    );
    sharedClientMocks.readCodexAppServerClientDesktopGeneration.mockReturnValue({
      epoch: 1,
      fingerprint: "desktop-x",
    });
    sharedClientMocks.assertCodexAppServerClientStartSelectionCurrent.mockImplementation(() => {
      throw Object.assign(new Error("desktop selection changed"), {
        code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
      });
    });

    await expect(
      installCodexComputerUse({
        agentDir,
        client,
        request: vi.fn(),
        pluginConfig: { computerUse: { enabled: true, autoInstall: false } },
      }),
    ).rejects.toThrow("desktop selection changed");
    expect(managedProvisioningMocks.ensureCodexManagedBundledMarketplace).not.toHaveBeenCalled();
    expect(managedProvisioningMocks.ensureCodexComputerUseServiceApp).not.toHaveBeenCalled();
  });

  it("allows auto-install from a configured local marketplace path", async () => {
    const request = createComputerUseRequest({ installed: false });

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          autoInstall: true,
          marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      message: "Computer Use is ready.",
    });
    expectRequestMethodNotCalled(request, "marketplace/add");
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
  });

  it("requires an explicit install command for configured marketplace sources", async () => {
    const request = createComputerUseRequest({ installed: false });

    await expectSetupErrorStatus(
      ensureCodexComputerUse({
        pluginConfig: {
          computerUse: {
            enabled: true,
            autoInstall: true,
            marketplaceSource: "github:example/desktop-tools",
          },
        },
        request,
      }),
      {
        reason: "auto_install_blocked",
      },
    );
    expectRequestMethodNotCalled(request, "marketplace/add");
    expectRequestMethodNotCalled(request, "plugin/install");
  });

  it("fails closed when a configured marketplace name is not discovered", async () => {
    const request = createEmptyMarketplaceComputerUseRequest();

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: "missing-marketplace",
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "marketplace_missing",
      message:
        "Configured Codex marketplace missing-marketplace was not found or does not contain computer-use. Run /codex computer-use install with a source or path to install from a new marketplace.",
    });
    expectRequestMethodNotCalled(request, "plugin/read");
  });

  it("reads installed remote Computer Use plugins by their opaque Codex id", async () => {
    const request = createComputerUseRequest({
      installed: true,
      remoteMarketplace: {
        name: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        pluginId: REMOTE_COMPUTER_USE_PLUGIN_ID,
      },
    });

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      installed: true,
      pluginEnabled: true,
      marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
      tools: ["list_apps"],
    });
    expect(request).toHaveBeenCalledWith("plugin/read", {
      remoteMarketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
      pluginName: REMOTE_COMPUTER_USE_PLUGIN_ID,
    });
    expectRequestMethodNotCalled(request, "marketplace/add");
    expectRequestMethodNotCalled(request, "experimentalFeature/enablement/set");
    expectRequestMethodNotCalled(request, "plugin/install");
    expectRequestMethodNotCalled(request, "config/mcpServer/reload");
  });

  it("auto-installs discovered remote Computer Use only when explicitly configured", async () => {
    const request = createComputerUseRequest({
      installed: false,
      remoteMarketplace: {
        name: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        pluginId: REMOTE_COMPUTER_USE_PLUGIN_ID,
      },
    });

    const status = await ensureCodexComputerUse({
      pluginConfig: {
        computerUse: {
          enabled: true,
          autoInstall: true,
          marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        },
      },
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
    expectRequestMethodNotCalled(request, "marketplace/add");
  });

  it("fails closed before reading a remote Computer Use plugin without its opaque id", async () => {
    const request = createComputerUseRequest({
      installed: false,
      remoteMarketplace: {
        name: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        pluginId: null,
      },
    });

    const status = await readCodexComputerUseStatus({
      pluginConfig: {
        computerUse: {
          enabled: true,
          marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME,
        },
      },
      request,
    });

    expectStatusFields(status, {
      ready: false,
      reason: "marketplace_missing",
      installed: false,
      pluginEnabled: false,
    });
    expectRequestMethodNotCalled(request, "plugin/read");
    expectRequestMethodNotCalled(request, "plugin/install");
    expectRequestMethodNotCalled(request, "experimentalFeature/enablement/set");

    await expectSetupErrorStatus(
      installCodexComputerUse({
        pluginConfig: {
          computerUse: { marketplaceName: REMOTE_COMPUTER_USE_MARKETPLACE_NAME },
        },
        request,
      }),
      { ready: false, reason: "marketplace_missing" },
    );
    expectRequestMethodNotCalled(request, "plugin/read");
    expectRequestMethodNotCalled(request, "plugin/install");
    expectRequestMethodNotCalled(request, "marketplace/add");
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
    expectRequestMethodNotCalled(request, "marketplace/add");
    expectRequestMethodNotCalled(request, "experimentalFeature/list");
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

    const status = await installed;
    expectStatusFields(status, {
      ready: true,
      reason: "ready",
      message: "Computer Use is ready.",
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
    expect(
      vi.mocked(request).mock.calls.filter(([method]) => method === "plugin/list"),
    ).toHaveLength(3);
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

    expect(requestCalls(request).filter(([method]) => method === "plugin/list")).toHaveLength(1);
    expect(
      requestCalls(request).filter(([method]) => method === "experimentalFeature/list"),
    ).toHaveLength(1);
    expectRequestMethodNotCalled(request, "plugin/install");
    await expect(install).rejects.toThrow("/codex computer-use install");
  });

  it("keeps waiting for marketplace discovery when the feature list does not report plugins", async () => {
    vi.useFakeTimers();
    const request = createComputerUseRequest({
      installed: false,
      nativePluginsEnabled: "absent",
      marketplaceAvailableAfterListCalls: 3,
    });
    const installed = installCodexComputerUse({
      pluginConfig: { computerUse: {} },
      request,
    });

    await vi.advanceTimersByTimeAsync(4_000);

    expectStatusFields(await installed, { ready: true, reason: "ready" });
    expect(requestCalls(request).filter(([method]) => method === "plugin/list")).toHaveLength(3);
    expect(
      requestCalls(request).filter(([method]) => method === "experimentalFeature/list"),
    ).toHaveLength(1);
  });
});

function createAmbiguousComputerUseRequest(): CodexComputerUseRequest {
  return vi.fn(async (method: string) => {
    if (method === "plugin/list") {
      return {
        marketplaces: [
          {
            name: "desktop-tools",
            path: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
            interface: null,
            plugins: [pluginSummary(true, "desktop-tools")],
          },
          {
            name: "other-tools",
            path: "/marketplaces/other-tools/.agents/plugins/marketplace.json",
            interface: null,
            plugins: [pluginSummary(true, "other-tools")],
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function createEmptyMarketplaceComputerUseRequest(): CodexComputerUseRequest {
  return vi.fn(async (method: string) => {
    if (method === "plugin/list") {
      return {
        marketplaces: [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
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
  let installed = false;
  let threadStartCalls = 0;
  return vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === "experimentalFeature/enablement/set") {
      return { enablement: { plugins: true } };
    }
    if (method === "config/read") {
      return {
        config: configuredSource
          ? {
              marketplaces: {
                "openai-bundled": { source_type: "local", source: configuredSource },
              },
            }
          : {},
        origins: configuredSource
          ? {
              "marketplaces.openai-bundled.source": {
                name:
                  options.configuredSourceOrigin === "system"
                    ? { type: "system", file: "/etc/codex/config.toml" }
                    : {
                        type: "user",
                        file: options.configuredSourceProfile
                          ? path.join(codexHome, `${options.configuredSourceProfile}.config.toml`)
                          : path.join(codexHome, "config.toml"),
                        profile: options.configuredSourceProfile ?? null,
                      },
                version: "legacy-config",
              },
            }
          : {},
        layers: null,
      };
    }
    if (method === "marketplace/remove") {
      expect(requestParams).toEqual({ marketplaceName: "openai-bundled" });
      configuredSource = undefined;
      registered = false;
      return { marketplaceName: "openai-bundled", installedRoot: null };
    }
    if (method === "marketplace/add") {
      expect(requestParams).toEqual({
        source: bundledMarketplacePath,
      });
      if (configuredSource && configuredSource !== bundledMarketplacePath) {
        throw new Error(
          "marketplace 'openai-bundled' is already added from a different source; remove it before adding this source | -32600",
        );
      }
      configuredSource = bundledMarketplacePath;
      registered = true;
      return {
        marketplaceName: "openai-bundled",
        installedRoot: bundledMarketplacePath,
        alreadyAdded: false,
      };
    }
    if (method === "plugin/list") {
      return {
        marketplaces: registered
          ? [
              {
                name: "openai-bundled",
                path: `${bundledMarketplacePath}/.agents/plugins/marketplace.json`,
                interface: null,
                plugins: [pluginSummary(installed, "openai-bundled")],
              },
            ]
          : [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    if (method === "plugin/read") {
      return {
        plugin: {
          marketplaceName: "openai-bundled",
          marketplacePath: `${bundledMarketplacePath}/.agents/plugins/marketplace.json`,
          summary: pluginSummary(installed, "openai-bundled"),
          description: "Control desktop apps.",
          skills: [],
          apps: [],
          mcpServers: ["computer-use"],
        },
      };
    }
    if (method === "plugin/install") {
      installed = true;
      return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
    }
    if (method === "config/mcpServer/reload") {
      return undefined;
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: installed
          ? [
              {
                name: "computer-use",
                tools: {
                  list_apps: {
                    name: "list_apps",
                    inputSchema: { type: "object" },
                  },
                },
                resources: [],
                resourceTemplates: [],
                authStatus: "unsupported",
              },
            ]
          : [],
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      threadStartCalls += 1;
      return {
        thread: { id: `bundled-marketplace-probe-thread-${threadStartCalls}` },
        model: "gpt-5.1",
        modelProvider: "openai",
      };
    }
    if (method === "mcpServer/tool/call") {
      return { content: [{ type: "text", text: "[]" }] };
    }
    if (method === "thread/unsubscribe") {
      return undefined;
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function createDesktopInstallClient(root: string, commandSource = "config") {
  const agentDir = path.join(root, "agent");
  const codexHome = path.join(agentDir, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  const client = createClientHarness().client;
  vi.spyOn(client, "getRuntimeIdentity").mockReturnValue({
    serverVersion: "0.148.0",
    codexHome,
  });
  sharedClientMocks.readCodexAppServerClientProcessIdentity.mockReturnValue({
    clientId: "client-explicit-install",
    command: "/Applications/ChatGPT.app/Contents/Resources/codex",
    commandSource,
    argsFingerprint: "args",
  });
  return { agentDir, codexHome, client };
}

function createManagedMarketplaceHarness(root: string): {
  agentDir: string;
  client: ReturnType<typeof createClientHarness>["client"];
  managedMarketplacePath: string;
} {
  const agentDir = path.join(root, "agent");
  const codexHome = path.join(agentDir, "codex-home");
  const managedMarketplacePath = path.join(
    codexHome,
    ".tmp",
    "bundled-marketplaces",
    "openai-bundled",
  );
  fs.mkdirSync(managedMarketplacePath, { recursive: true });
  const client = createClientHarness().client;
  vi.spyOn(client, "getRuntimeIdentity").mockReturnValue({
    serverVersion: "0.149.1",
    codexHome,
  });
  return { agentDir, client, managedMarketplacePath };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
