import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatComputerUseStatus } from "../command-formatters.js";
import { ensureCodexManagedBundledMarketplace as ensureMarketplace } from "./computer-use-marketplace.js";
import {
  hasLegacyCodexComputerUseMcpPolicy,
  resolveManagedCodexComputerUseConfig,
} from "./computer-use-unified.js";
import {
  ensureCodexComputerUse as ensureComputerUse,
  installCodexComputerUse as installComputerUse,
  readCodexComputerUseStatus as readStatus,
} from "./computer-use.js";
import { createComputerUseRequest, expectSetupErrorStatus } from "./computer-use.test-support.js";
import type { CodexPluginConfig } from "./config.js";
import { resolveCodexComputerUseConfig } from "./config.js";
import type { MacOSDesktopCodexAppPathCandidate } from "./desktop-app-paths.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./test-support.js";

describe("managed unified Computer Use marketplace", () => {
  const clients: ReturnType<typeof createClientHarness>["client"][] = [];
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      for (const client of clients.splice(0)) {
        client.close();
      }
      cleanup();
    }),
  );
  const disabledStatus = {
    ready: false,
    reason: "plugin_disabled" as const,
    installed: null,
    pluginName: "computer-use",
    mcpServerName: "computer-use",
  };

  async function fixture(commandRelative = "codex") {
    const root = tempDirs.make("openclaw-unified-computer-use-");
    const candidate = await writeUnifiedCandidate(root, commandRelative);
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    return {
      root,
      candidate,
      agentDir,
      codexHome,
      params: { codexHome, ownershipRoot: agentDir, candidates: [candidate] },
    };
  }

  function nativeClient(
    codexHome: string,
    installed: boolean,
    config: () => object,
    computerUse: CodexPluginConfig["computerUse"] = {},
    afterRequest?: (method: string) => void,
  ) {
    const { client } = createClientHarness();
    clients.push(client);
    vi.spyOn(client, "getRuntimeIdentity").mockReturnValue({ serverVersion: "0.155.0", codexHome });
    const request = createComputerUseRequest({
      installed,
      pluginName: "unified-computer-use",
      mcpServerName: "cua_repl",
      mcpTools: ["js"],
    });
    const native = vi.mocked(request).getMockImplementation();
    if (!native) {
      throw new Error("Expected a native request fixture");
    }
    vi.mocked(request).mockImplementation(async (method, params, options) => {
      if (method === "config/read") {
        return { config: config(), origins: {}, layers: null };
      }
      const result = await native(method, params, options);
      afterRequest?.(method);
      return result;
    });
    return {
      client,
      request,
      agentDir: path.dirname(codexHome),
      pluginConfig: { computerUse: { enabled: true, ...computerUse } },
    };
  }

  it.each(["stale", "disabled"])(
    "reconciles an installed unified cache during automatic readiness (%s)",
    async (cacheState) => {
      const { codexHome, params: marketplaceParams } = await fixture();
      const marketplace = await publishMarketplace(marketplaceParams);
      const source = unifiedPluginPath(marketplace);
      const cache = path.join(codexHome, "plugins/cache/openai-bundled/unified-computer-use/2.0.0");
      await fs.cp(source, cache, { recursive: true });
      const currentMcp = await fs.readFile(path.join(source, ".mcp.json"), "utf8");
      const stale = JSON.parse(currentMcp);
      stale.mcpServers.cua_repl.command = "/previous-desktop/cua_node/bin/node";
      stale.mcpServers.cua_repl.env.SKY_CUA_SERVICE_PATH = "/previous-home/service.app";
      await writeJson(path.join(cache, ".mcp.json"), stale);
      const before = await fs.lstat(cache);
      const beforeMcp = await fs.readFile(path.join(cache, ".mcp.json"), "utf8");
      const params = nativeClient(
        codexHome,
        true,
        () => nativePolicy({ enabled: cacheState !== "disabled" }),
        { autoInstall: true, pluginCacheMode: "shared", strictReadiness: false },
      );
      if (cacheState === "disabled") {
        await expectSetupErrorStatus(ensureComputerUse(params), disabledStatus);
      } else {
        await expect(ensureComputerUse(params)).resolves.toMatchObject({ ready: true });
      }
      const after = await fs.lstat(cache);
      expect([after.isDirectory(), after.isSymbolicLink()]).toEqual([true, false]);
      expect(await fs.readFile(path.join(cache, ".mcp.json"), "utf8")).toBe(
        cacheState === "disabled" ? beforeMcp : currentMcp,
      );
      if (cacheState === "stale") {
        expect(after.ino).not.toBe(before.ino);
        await expect(ensureComputerUse(params)).resolves.toMatchObject({ ready: true });
        expect(await fs.readFile(path.join(cache, ".mcp.json"), "utf8")).toBe(currentMcp);
      }
      expect((await fs.lstat(cache)).ino).toBe(cacheState === "stale" ? after.ino : before.ino);
      const methods = vi.mocked(params.request).mock.calls.map(([method]) => method);
      expect(methods).not.toContain("plugin/install");
      if (cacheState === "disabled") {
        expect(methods).not.toContain("mcpServerStatus/list");
        expect(methods).not.toContain("experimentalFeature/enablement/set");
      }
    },
  );

  it("materializes read-only templates from the outer signed desktop bundle", async () => {
    const { root, candidate } = await fixture("codex-cli/CodexCLI.app/Contents/MacOS/codex");
    const sourcePlugin = unifiedPluginPath(candidate.bundledMarketplacePath);
    const original = await fs.readFile(path.join(sourcePlugin, ".mcp.json"), "utf8");
    const runtimeRoot = path.join(candidate.appBundlePath, "Contents", "Resources", "cua_node");
    for (const name of ["first", "second"]) {
      const codexHome = path.join(root, name, "codex-home");
      const params = { codexHome, ownershipRoot: path.dirname(codexHome), candidates: [candidate] };
      const target = await publishMarketplace({
        ...params,
        appServerCommand: candidate.appServerCommandPath,
      });
      const pluginRoot = unifiedPluginPath(target);
      const materialized = await readJson(path.join(pluginRoot, ".mcp.json"));
      expect((await fs.stat(path.join(pluginRoot, ".mcp.json"))).mode & 0o200).toBe(0o200);
      expect(materialized.mcpServers.cua_repl).toMatchObject({
        enabled: true,
        command: path.join(runtimeRoot, "bin", "node"),
        args: [path.join(runtimeRoot, "lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs")],
        enabled_tools: ["js", "js_reset", "turn_ended"],
        env: {
          CODEX_HOME: codexHome,
          CUA_REPL_NODE_REPL_PATH: path.join(runtimeRoot, "bin", "node_repl"),
          CUA_REPL_ENABLED_SURFACES: "computer",
          SKY_CUA_SERVICE_PATH: path.join(codexHome, "computer-use", "Codex Computer Use.app"),
          NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
        },
      });
      expect(materialized.mcpServers.cua_repl.env).not.toHaveProperty(
        "BROWSER_USE_AVAILABLE_BACKENDS",
      );
      expect(await fs.realpath(path.join(target, "plugins", "browser-use"))).toBe(
        path.join(candidate.bundledMarketplacePath, "plugins", "browser-use"),
      );
      await expect(ensureMarketplace(params)).resolves.toBe(target);
      const native = nativeClient(codexHome, true, () => ({}), { pluginName: "computer-use" });
      await expect(ensureComputerUse(native)).resolves.toMatchObject({
        ready: true,
        pluginName: "unified-computer-use",
        mcpServerName: "cua_repl",
        tools: ["js"],
      });
      for (const override of [
        { pluginName: "custom-computer" },
        { mcpServerName: "custom-server" },
        { marketplaceName: "custom-marketplace" },
        { marketplacePath: "/operator/marketplace" },
        { marketplaceSource: "operator-source" },
      ]) {
        const config = resolveCodexComputerUseConfig({
          pluginConfig: { computerUse: { enabled: true, ...override } },
        });
        expect(await resolveManagedCodexComputerUseConfig(config, target)).toBe(config);
      }
    }
    expect(await fs.readFile(path.join(sourcePlugin, ".mcp.json"), "utf8")).toBe(original);
    expect((await fs.stat(path.join(sourcePlugin, ".mcp.json"))).mode & 0o222).toBe(0);
  });

  it.each([
    { action: "ensure", autoInstall: false, disableAt: "initial", installed: false },
    { action: "status", autoInstall: false, disableAt: "initial", installed: true },
    { action: "install", autoInstall: false, disableAt: "initial", installed: false },
    { action: "ensure", autoInstall: true, disableAt: "plugin/read", installed: false },
    { action: "ensure", autoInstall: true, disableAt: "never", installed: false },
    { action: "ensure", autoInstall: true, disableAt: "plugin/read", installed: true },
  ] as const)(
    "$action with autoInstall=$autoInstall and native disable at $disableAt (installed=$installed)",
    async ({ action, autoInstall, disableAt, installed }) => {
      const { codexHome, params: marketplaceParams } = await fixture();
      await publishMarketplace(marketplaceParams);
      let nativeDisabled = disableAt === "initial";
      let installing = false;
      const params = nativeClient(
        codexHome,
        installed,
        () => nativePolicy({ enabled: !nativeDisabled }),
        { autoInstall },
        (method) => {
          if (method === "experimentalFeature/enablement/set") {
            installing = true;
          }
          if ((installing || installed) && method === disableAt) {
            nativeDisabled = true;
          }
        },
      );
      if (action === "install" || disableAt === "never") {
        await expect(
          action === "install" ? installComputerUse(params) : ensureComputerUse(params),
        ).resolves.toMatchObject({
          ready: true,
          installed: true,
          pluginEnabled: true,
          pluginName: "unified-computer-use",
          tools: ["js"],
        });
        expect(vi.mocked(params.request).mock.calls.map(([method]) => method)).toContain(
          "plugin/install",
        );
        return;
      }
      if (action === "status") {
        const result = await readStatus(params);
        expect(result).toMatchObject({
          ...disabledStatus,
          installation: { status: "unchecked", ok: false },
        });
        const display = formatComputerUseStatus(result);
        expect(display).toContain("Plugin: computer-use (installation unchecked)");
        expect(display).toContain("Installation: unchecked");
        expect(display).toContain("/codex computer-use install");
        expect(display).not.toContain("not installed");
      } else {
        await expectSetupErrorStatus(ensureComputerUse(params), disabledStatus);
      }
      const methods = vi.mocked(params.request).mock.calls.map(([method]) => method);
      expect(methods).not.toContain("plugin/install");
      expect(methods).not.toContain("mcpServerStatus/list");
      if (disableAt === "initial") {
        expect(methods).not.toContain("experimentalFeature/enablement/set");
      }
    },
  );

  it.each(["desktop-generation", "explicit-install"])(
    "refreshes copied plugin content for %s",
    async (refresh) => {
      const { candidate, params } = await fixture();
      const sourceHook = unifiedPluginPath(candidate.bundledMarketplacePath, "hook.js");
      await fs.writeFile(sourceHook, "first official hook");
      const target = await publishMarketplace({ ...params, desktopFingerprint: "desktop-x" });
      const targetHook = unifiedPluginPath(target, "hook.js");
      expect(await fs.readFile(targetHook, "utf8")).toBe("first official hook");
      await fs.writeFile(sourceHook, "updated official hook");
      await expect(
        ensureMarketplace({
          ...params,
          desktopFingerprint: refresh === "desktop-generation" ? "desktop-y" : "desktop-x",
          forceRefresh: refresh === "explicit-install",
        }),
      ).resolves.toBe(target);
      expect(await fs.readFile(targetHook, "utf8")).toBe("updated official hook");
    },
  );

  it("publishes newly added sibling plugins without a unified runtime change", async () => {
    const { candidate, params } = await fixture();
    const target = await publishMarketplace(params);
    const siblingSource = "./plugins/new-sibling";
    const siblingManifest = { name: "new-sibling", version: "1.0.0" };
    const sourcePlugin = path.join(candidate.bundledMarketplacePath, siblingSource);
    await writeJson(path.join(sourcePlugin, ".codex-plugin", "plugin.json"), siblingManifest);
    const manifestPath = path.join(target, ".agents", "plugins", "marketplace.json");
    const manifest = await readJson(manifestPath);
    manifest.plugins.push({
      name: siblingManifest.name,
      source: { source: "local", path: siblingSource },
    });
    await writeJson(manifestPath, manifest);
    await expect(ensureMarketplace(params)).resolves.toBe(target);
    const publishedManifest = await readJson(manifestPath);
    const sibling = publishedManifest.plugins.find(
      (plugin: { name: string }) => plugin.name === siblingManifest.name,
    );
    expect(
      await readJson(path.join(target, sibling.source.path, ".codex-plugin/plugin.json")),
    ).toEqual(siblingManifest);
  });

  it("retains explicit legacy native server and per-tool policy boundaries", () => {
    expect(
      [
        { mcp_servers: { "computer-use": { enabled: false } } },
        nativePolicy({ mcp_servers: { "computer-use": { enabled_tools: ["list_apps"] } } }),
        nativePolicy({ enabled: true }),
        { mcp_servers: { cua_repl: { enabled: false } } },
      ].map(hasLegacyCodexComputerUseMcpPolicy),
    ).toEqual([true, true, false, false]);
  });

  it("keeps a usable legacy plugin and refuses incomplete replacement assets before publication", async () => {
    const { candidate, params } = await fixture();
    const legacyManifest = path.join(
      candidate.bundledMarketplacePath,
      "plugins/computer-use/.codex-plugin/plugin.json",
    );
    await writeJson(legacyManifest, {
      name: "computer-use",
      version: "1.0.0",
      mcpServers: "./.mcp.json",
    });
    const target = await publishMarketplace(params);
    const config = resolveCodexComputerUseConfig({
      pluginConfig: { computerUse: { enabled: true } },
    });
    expect(await resolveManagedCodexComputerUseConfig(config, target)).toBe(config);
    const publishedPath = unifiedPluginPath(target, ".mcp.json");
    const published = await fs.readFile(publishedPath, "utf8");
    await fs.rm(
      path.join(path.dirname(candidate.appServerCommandPath), "cua_node", "bin", "node_repl"),
    );
    await expect(ensureMarketplace(params)).resolves.toBe(target);
    await writeJson(legacyManifest, { name: "computer-use", version: "2.0.0" });
    for (const customIdentity of [
      { computerUsePluginName: "operator-computer-use" },
      { computerUsePluginName: "computer-use", computerUseMcpServerName: "operator-server" },
    ]) {
      await expect(ensureMarketplace({ ...params, ...customIdentity })).resolves.toBe(target);
    }
    await expect(ensureMarketplace(params)).rejects.toThrow("runtime is incomplete");
    expect(await fs.readFile(publishedPath, "utf8")).toBe(published);
  });
});

async function publishMarketplace(params: Parameters<typeof ensureMarketplace>[0]) {
  const target = await ensureMarketplace(params);
  if (!target) {
    throw new Error("Expected the managed marketplace fixture to be published");
  }
  return target;
}

async function writeJson(file: string, value: unknown, mode?: number) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value), { mode });
}

function nativePolicy(policy: object) {
  return { plugins: { "computer-use@openai-bundled": policy } };
}

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function unifiedPluginPath(marketplace: string, file = "") {
  return path.join(marketplace, "plugins/unified-computer-use", file);
}

async function writeUnifiedCandidate(
  root: string,
  commandRelative = "codex",
): Promise<MacOSDesktopCodexAppPathCandidate> {
  const appBundlePath = path.join(root, "ChatGPT.app");
  const resources = path.join(appBundlePath, "Contents", "Resources");
  const bundledMarketplacePath = path.join(resources, "plugins", "openai-bundled");
  const pluginRoot = path.join(bundledMarketplacePath, "plugins");
  const runtimeRoot = path.join(resources, "cua_node");
  const names = ["computer-use", "unified-computer-use", "browser-use"];
  await writeJson(path.join(bundledMarketplacePath, ".agents/plugins/marketplace.json"), {
    name: "openai-bundled",
    plugins: names.map((name) => ({
      name,
      source: { source: "local", path: `./plugins/${name}` },
    })),
  });
  for (const name of names) {
    await writeJson(path.join(pluginRoot, name, ".codex-plugin/plugin.json"), {
      name,
      version: "2.0.0",
      ...(name === "unified-computer-use" ? { mcpServers: "./.mcp.json" } : {}),
    });
  }
  await writeJson(
    path.join(pluginRoot, "unified-computer-use/.mcp.json"),
    {
      mcpServers: {
        cua_repl: {
          command: "node",
          args: [],
          enabled: false,
          enabled_tools: ["js", "js_reset", "turn_ended"],
        },
      },
    },
    0o444,
  );
  for (const relative of [
    "bin/node",
    "bin/node_repl",
    "lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs",
    "lib/node_modules/@oai/sky/package.json",
    "lib/node_modules/@oai/cua/tinysky-alt.js",
  ]) {
    const file = path.join(runtimeRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "synthetic fixture", { mode: 0o755 });
  }
  await writeJson(path.join(runtimeRoot, "lib/node_modules/@oai/cua/package.json"), {
    exports: { "./tinyskyAlt": "./tinysky-alt.js" },
  });
  return {
    appName: "ChatGPT.app",
    appBundlePath,
    appServerCommandPath: path.join(resources, commandRelative),
    bundledMarketplacePath,
    computerUseServiceAppPaths: [],
  };
}
