import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCodexManagedBundledMarketplace } from "./computer-use-marketplace.js";
import {
  hasLegacyCodexComputerUseMcpPolicy,
  resolveManagedCodexComputerUseConfig,
} from "./computer-use-unified.js";
import { ensureCodexComputerUse } from "./computer-use.js";
import { createComputerUseRequest } from "./computer-use.test-support.js";
import { resolveCodexComputerUseConfig } from "./config.js";
import type { MacOSDesktopCodexAppPathCandidate } from "./desktop-app-paths.js";
import { createClientHarness, useAutoCleanupTempDirTracker } from "./test-support.js";

describe("managed unified Computer Use marketplace", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["codex", "codex-cli/CodexCLI.app/Contents/MacOS/codex"])(
    "materializes read-only desktop templates for %s before native installation",
    async (commandRelative) => {
      const root = tempDirs.make("openclaw-unified-computer-use-");
      const candidate = await writeUnifiedCandidate(root, commandRelative);
      const sourcePlugin = path.join(
        candidate.bundledMarketplacePath,
        "plugins",
        "unified-computer-use",
      );
      const original = await fs.readFile(path.join(sourcePlugin, ".mcp.json"), "utf8");
      const homes = ["first", "second"].map((name) => path.join(root, name, "codex-home"));

      for (const codexHome of homes) {
        const target = await ensureCodexManagedBundledMarketplace({
          codexHome,
          ownershipRoot: path.dirname(codexHome),
          candidates: [candidate],
          appServerCommand: candidate.appServerCommandPath,
        });
        if (!target) {
          throw new Error("Expected the managed marketplace fixture to be published");
        }
        const pluginRoot = path.join(target, "plugins", "unified-computer-use");
        const materialized = JSON.parse(
          await fs.readFile(path.join(pluginRoot, ".mcp.json"), "utf8"),
        );
        const runtimeRoot = path.join(candidate.appBundlePath, "Contents", "Resources", "cua_node");
        expect((await fs.stat(path.join(pluginRoot, ".mcp.json"))).mode & 0o200).toBe(0o200);
        expect(materialized.mcpServers.cua_repl).toMatchObject({
          enabled: true,
          command: path.join(runtimeRoot, "bin", "node"),
          args: [
            path.join(
              runtimeRoot,
              "lib",
              "node_modules",
              "@oai",
              "cua-repl",
              "bin",
              "cua-repl.mjs",
            ),
          ],
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
        // Native plugin/install copies this source; a reinstall must retain the same launch contract.
        const installed = path.join(codexHome, "installed-plugin");
        await fs.cp(pluginRoot, installed, { recursive: true });
        expect(JSON.parse(await fs.readFile(path.join(installed, ".mcp.json"), "utf8"))).toEqual(
          materialized,
        );
        await expect(
          ensureCodexManagedBundledMarketplace({
            codexHome,
            ownershipRoot: path.dirname(codexHome),
            candidates: [candidate],
          }),
        ).resolves.toBe(target);

        const { client } = createClientHarness();
        vi.spyOn(client, "getRuntimeIdentity").mockReturnValue({
          serverVersion: "0.155.0",
          codexHome,
        });
        const request = createComputerUseRequest({
          installed: true,
          pluginName: "unified-computer-use",
          mcpServerName: "cua_repl",
          mcpTools: ["js"],
        });
        const nativeRequest = vi.mocked(request).getMockImplementation();
        if (!nativeRequest) {
          throw new Error("Expected a native request fixture implementation");
        }
        vi.mocked(request).mockImplementation(async (method, requestParams, options) =>
          method === "config/read"
            ? { config: {}, origins: {}, layers: null }
            : await nativeRequest(method, requestParams, options),
        );
        try {
          await expect(
            ensureCodexComputerUse({
              client,
              request,
              agentDir: path.dirname(codexHome),
              pluginConfig: { computerUse: { enabled: true, pluginName: "computer-use" } },
            }),
          ).resolves.toMatchObject({
            ready: true,
            pluginName: "unified-computer-use",
            mcpServerName: "cua_repl",
            tools: ["js"],
          });
        } finally {
          client.close();
        }

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
    },
  );

  it("refreshes same-version official plugin content in the native installation source", async () => {
    const root = tempDirs.make("openclaw-unified-computer-use-refresh-");
    const candidate = await writeUnifiedCandidate(root);
    const codexHome = path.join(root, "agent", "codex-home");
    const sourceHook = path.join(
      candidate.bundledMarketplacePath,
      "plugins",
      "unified-computer-use",
      "hook.js",
    );
    await fs.writeFile(sourceHook, "first official hook");
    const params = { codexHome, ownershipRoot: path.dirname(codexHome), candidates: [candidate] };
    const target = await ensureCodexManagedBundledMarketplace(params);
    if (!target) {
      throw new Error("Expected the managed source to be published");
    }
    const targetHook = path.join(target, "plugins", "unified-computer-use", "hook.js");
    expect(await fs.readFile(targetHook, "utf8")).toBe("first official hook");
    await fs.writeFile(sourceHook, "updated official hook");
    await expect(ensureCodexManagedBundledMarketplace(params)).resolves.toBe(target);
    expect(await fs.readFile(targetHook, "utf8")).toBe("updated official hook");
  });

  it("publishes newly added sibling plugins without a unified runtime change", async () => {
    const root = tempDirs.make("openclaw-unified-computer-use-sibling-");
    const candidate = await writeUnifiedCandidate(root);
    const codexHome = path.join(root, "agent", "codex-home");
    const params = { codexHome, ownershipRoot: path.dirname(codexHome), candidates: [candidate] };
    const target = await ensureCodexManagedBundledMarketplace(params);
    if (!target) {
      throw new Error("Expected the managed source to be published");
    }

    const siblingSource = "./plugins/new-sibling";
    const siblingManifest = { name: "new-sibling", version: "1.0.0" };
    const sourcePlugin = path.join(candidate.bundledMarketplacePath, siblingSource);
    await fs.mkdir(path.join(sourcePlugin, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(sourcePlugin, ".codex-plugin", "plugin.json"),
      JSON.stringify(siblingManifest),
    );
    const manifestPath = path.join(target, ".agents", "plugins", "marketplace.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.plugins.push({
      name: siblingManifest.name,
      source: { source: "local", path: siblingSource },
    });
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    await expect(ensureCodexManagedBundledMarketplace(params)).resolves.toBe(target);
    const publishedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const sibling = publishedManifest.plugins.find(
      (plugin: { name: string }) => plugin.name === siblingManifest.name,
    );
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(target, sibling.source.path, ".codex-plugin", "plugin.json"),
          "utf8",
        ),
      ),
    ).toEqual(siblingManifest);
  });

  it("retains explicit legacy native server and per-tool policy boundaries", () => {
    expect(
      hasLegacyCodexComputerUseMcpPolicy({ mcp_servers: { "computer-use": { enabled: false } } }),
    ).toBe(true);
    expect(
      hasLegacyCodexComputerUseMcpPolicy({
        plugins: {
          "computer-use@openai-bundled": {
            mcp_servers: { "computer-use": { enabled_tools: ["list_apps"] } },
          },
        },
      }),
    ).toBe(true);
    expect(
      hasLegacyCodexComputerUseMcpPolicy({
        plugins: { "computer-use@openai-bundled": { enabled: true } },
      }),
    ).toBe(false);
    expect(
      hasLegacyCodexComputerUseMcpPolicy({ mcp_servers: { cua_repl: { enabled: false } } }),
    ).toBe(false);
  });

  it("keeps a usable legacy plugin and refuses incomplete replacement assets before publication", async () => {
    const root = tempDirs.make("openclaw-unified-computer-use-incomplete-");
    const candidate = await writeUnifiedCandidate(root);
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    const legacyManifest = path.join(
      candidate.bundledMarketplacePath,
      "plugins",
      "computer-use",
      ".codex-plugin",
      "plugin.json",
    );
    await fs.writeFile(
      legacyManifest,
      JSON.stringify({ name: "computer-use", version: "1.0.0", mcpServers: "./.mcp.json" }),
    );
    const target = await ensureCodexManagedBundledMarketplace({
      codexHome,
      ownershipRoot: agentDir,
      candidates: [candidate],
    });
    if (!target) {
      throw new Error("Expected the legacy marketplace fixture to be published");
    }
    const config = resolveCodexComputerUseConfig({
      pluginConfig: { computerUse: { enabled: true } },
    });
    expect(await resolveManagedCodexComputerUseConfig(config, target)).toBe(config);
    const published = await fs.readFile(
      path.join(target, "plugins", "unified-computer-use", ".mcp.json"),
      "utf8",
    );
    await fs.rm(
      path.join(path.dirname(candidate.appServerCommandPath), "cua_node", "bin", "node_repl"),
    );
    await expect(
      ensureCodexManagedBundledMarketplace({
        codexHome,
        ownershipRoot: agentDir,
        candidates: [candidate],
      }),
    ).resolves.toBe(target);
    await fs.writeFile(legacyManifest, JSON.stringify({ name: "computer-use", version: "2.0.0" }));
    for (const customIdentity of [
      { computerUsePluginName: "operator-computer-use" },
      { computerUsePluginName: "computer-use", computerUseMcpServerName: "operator-server" },
    ]) {
      await expect(
        ensureCodexManagedBundledMarketplace({
          codexHome,
          ownershipRoot: agentDir,
          candidates: [candidate],
          ...customIdentity,
        }),
      ).resolves.toBe(target);
    }
    await expect(
      ensureCodexManagedBundledMarketplace({
        codexHome,
        ownershipRoot: agentDir,
        candidates: [candidate],
      }),
    ).rejects.toThrow("runtime is incomplete");
    expect(
      await fs.readFile(path.join(target, "plugins", "unified-computer-use", ".mcp.json"), "utf8"),
    ).toBe(published);
  });
});

async function writeUnifiedCandidate(
  root: string,
  commandRelative = "codex",
): Promise<MacOSDesktopCodexAppPathCandidate> {
  const appBundlePath = path.join(root, "ChatGPT.app");
  const resources = path.join(appBundlePath, "Contents", "Resources");
  const bundledMarketplacePath = path.join(resources, "plugins", "openai-bundled");
  const pluginRoot = path.join(bundledMarketplacePath, "plugins");
  const runtimeRoot = path.join(resources, "cua_node");
  await fs.mkdir(path.join(bundledMarketplacePath, ".agents", "plugins"), { recursive: true });
  const names = ["computer-use", "unified-computer-use", "browser-use"];
  await fs.writeFile(
    path.join(bundledMarketplacePath, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "openai-bundled",
      plugins: names.map((name) => ({
        name,
        source: { source: "local", path: `./plugins/${name}` },
      })),
    }),
  );
  for (const name of names) {
    await fs.mkdir(path.join(pluginRoot, name, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, name, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name,
        version: "2.0.0",
        ...(name === "unified-computer-use" ? { mcpServers: "./.mcp.json" } : {}),
      }),
    );
  }
  await fs.writeFile(
    path.join(pluginRoot, "unified-computer-use", ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        cua_repl: {
          command: "node",
          args: [],
          enabled: false,
          enabled_tools: ["js", "js_reset", "turn_ended"],
        },
      },
    }),
    { mode: 0o444 },
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
  await fs.writeFile(
    path.join(runtimeRoot, "lib", "node_modules", "@oai", "cua", "package.json"),
    JSON.stringify({ exports: { "./tinyskyAlt": "./tinysky-alt.js" } }),
  );
  return {
    appName: "ChatGPT.app",
    appBundlePath,
    appServerCommandPath: path.join(resources, commandRelative),
    bundledMarketplacePath,
    computerUseServiceAppPaths: [],
  };
}
