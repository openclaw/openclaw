import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bundledDistPluginRootAt,
  bundledPluginRootAt,
} from "../../../test/helpers/bundled-plugin-paths.js";
import {
  ACPX_BUNDLED_BIN,
  ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME,
  ACPX_PINNED_VERSION,
  createAcpxPluginConfigSchema,
  resolveAcpxPluginRoot,
  resolveAcpxPluginConfig,
  resolvePluginToolsMcpServerConfig,
} from "./config.js";

describe("acpx plugin config parsing", () => {
  it("resolves source-layout plugin root from a file under src", () => {
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-root-source-"));
    try {
      fs.mkdirSync(path.join(pluginRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, "package.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "{}\n", "utf8");

      const moduleUrl = pathToFileURL(path.join(pluginRoot, "src", "config.ts")).href;
      expect(resolveAcpxPluginRoot(moduleUrl)).toBe(pluginRoot);
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it("resolves bundled-layout plugin root from the dist entry file", () => {
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-root-dist-"));
    try {
      fs.writeFileSync(path.join(pluginRoot, "package.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "{}\n", "utf8");

      const moduleUrl = pathToFileURL(path.join(pluginRoot, "index.js")).href;
      expect(resolveAcpxPluginRoot(moduleUrl)).toBe(pluginRoot);
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it("prefers the workspace plugin root for dist plugin bundles", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-root-workspace-"));
    const workspacePluginRoot = bundledPluginRootAt(repoRoot, "acpx");
    const bundledPluginRoot = bundledDistPluginRootAt(repoRoot, "acpx");
    try {
      fs.mkdirSync(workspacePluginRoot, { recursive: true });
      fs.mkdirSync(bundledPluginRoot, { recursive: true });
      fs.writeFileSync(path.join(workspacePluginRoot, "package.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(workspacePluginRoot, "openclaw.plugin.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(bundledPluginRoot, "package.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(bundledPluginRoot, "openclaw.plugin.json"), "{}\n", "utf8");

      const moduleUrl = pathToFileURL(path.join(bundledPluginRoot, "index.js")).href;
      expect(resolveAcpxPluginRoot(moduleUrl)).toBe(workspacePluginRoot);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("resolves bundled acpx with pinned version by default", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        cwd: "/tmp/workspace",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.command).toBe(ACPX_BUNDLED_BIN);
    expect(resolved.expectedVersion).toBe(ACPX_PINNED_VERSION);
    expect(resolved.allowPluginLocalInstall).toBe(true);
    expect(resolved.stripProviderAuthEnvVars).toBe(true);
    expect(resolved.cwd).toBe(path.resolve("/tmp/workspace"));
    expect(resolved.pluginToolsMcpBridge).toBe(false);
    expect(resolved.mcpServers).toEqual({});
    expect(resolved.strictWindowsCmdWrapper).toBe(true);
  });

  it("accepts command override and disables plugin-local auto-install", () => {
    const command = "/home/user/repos/acpx/dist/cli.js";
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        command,
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.command).toBe(path.resolve(command));
    expect(resolved.expectedVersion).toBeUndefined();
    expect(resolved.allowPluginLocalInstall).toBe(false);
    expect(resolved.stripProviderAuthEnvVars).toBe(false);
  });

  it("resolves relative command paths against workspace directory", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        command: "../acpx/dist/cli.js",
      },
      workspaceDir: "/home/user/repos/openclaw",
    });

    expect(resolved.command).toBe(path.resolve("/home/user/repos/openclaw", "../acpx/dist/cli.js"));
    expect(resolved.expectedVersion).toBeUndefined();
    expect(resolved.allowPluginLocalInstall).toBe(false);
    expect(resolved.stripProviderAuthEnvVars).toBe(false);
  });

  it("keeps bare command names as-is", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        command: "acpx",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.command).toBe("acpx");
    expect(resolved.expectedVersion).toBeUndefined();
    expect(resolved.allowPluginLocalInstall).toBe(false);
    expect(resolved.stripProviderAuthEnvVars).toBe(false);
  });

  it("accepts exact expectedVersion override", () => {
    const command = "/home/user/repos/acpx/dist/cli.js";
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        command,
        expectedVersion: "0.1.99",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.command).toBe(path.resolve(command));
    expect(resolved.expectedVersion).toBe("0.1.99");
    expect(resolved.allowPluginLocalInstall).toBe(false);
    expect(resolved.stripProviderAuthEnvVars).toBe(false);
  });

  it("treats expectedVersion=any as no version constraint", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        command: "/home/user/repos/acpx/dist/cli.js",
        expectedVersion: "any",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.expectedVersion).toBeUndefined();
  });

  it("rejects commandArgs overrides", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          commandArgs: ["--foo"],
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("unknown config key: commandArgs");
  });

  it("schema rejects empty cwd", () => {
    const schema = createAcpxPluginConfigSchema();
    if (!schema.safeParse) {
      throw new Error("acpx config schema missing safeParse");
    }
    const parsed = schema.safeParse({ cwd: "   " });

    expect(parsed.success).toBe(false);
  });

  it("injects the built-in plugin-tools MCP server only when explicitly enabled", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-plugin-tools-dist-"));
    const pluginRoot = path.join(repoRoot, "extensions", "acpx");
    const distEntry = path.join(repoRoot, "dist", "mcp", "plugin-tools-serve.js");
    try {
      fs.mkdirSync(path.join(pluginRoot, "src"), { recursive: true });
      fs.mkdirSync(path.dirname(distEntry), { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, "package.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(pluginRoot, "src", "config.ts"), "// test\n", "utf8");
      fs.writeFileSync(distEntry, "// built entry\n", "utf8");

      const resolved = resolveAcpxPluginConfig({
        rawConfig: {
          pluginToolsMcpBridge: true,
        },
        workspaceDir: repoRoot,
        moduleUrl: pathToFileURL(path.join(pluginRoot, "src", "config.ts")).href,
      });

      expect(resolved.pluginToolsMcpBridge).toBe(true);
      expect(resolved.mcpServers[ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME]).toEqual({
        command: process.execPath,
        args: [distEntry],
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the source plugin-tools MCP server entry when dist is absent", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-plugin-tools-src-"));
    const pluginRoot = path.join(repoRoot, "extensions", "acpx");
    const sourceConfigUrl = pathToFileURL(path.join(pluginRoot, "src", "config.ts")).href;
    try {
      fs.mkdirSync(path.join(pluginRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, "src", "mcp"), { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, "package.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(pluginRoot, "src", "config.ts"), "// test\n", "utf8");
      fs.writeFileSync(
        path.join(repoRoot, "src", "mcp", "plugin-tools-serve.ts"),
        "// test\n",
        "utf8",
      );

      expect(resolvePluginToolsMcpServerConfig(sourceConfigUrl)).toEqual({
        command: process.execPath,
        args: ["--import", "tsx", path.join(repoRoot, "src", "mcp", "plugin-tools-serve.ts")],
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects reserved MCP server name collisions when the plugin-tools bridge is enabled", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          pluginToolsMcpBridge: true,
          mcpServers: {
            [ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME]: {
              command: "node",
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow(
      `mcpServers.${ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME} is reserved when pluginToolsMcpBridge=true`,
    );
  });

  it("accepts strictWindowsCmdWrapper override", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        strictWindowsCmdWrapper: true,
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.strictWindowsCmdWrapper).toBe(true);
  });

  it("rejects non-boolean strictWindowsCmdWrapper", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          strictWindowsCmdWrapper: "yes",
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("strictWindowsCmdWrapper must be a boolean");
  });

  it("accepts skipJsonFormatArgs override", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        skipJsonFormatArgs: true,
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.skipJsonFormatArgs).toBe(true);
  });

  it("skipJsonFormatArgs defaults to false", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {},
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.skipJsonFormatArgs).toBe(false);
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema?: unknown };

    expect(createAcpxPluginConfigSchema().jsonSchema).toEqual(manifest.configSchema);
  });
});
