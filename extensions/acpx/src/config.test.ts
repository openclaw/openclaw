// ACPX tests cover config plugin behavior.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpxPluginConfigSchema } from "./config-schema.js";
import { resolveAcpxPluginConfig, resolveAcpxPluginRoot } from "./config.js";

const requireFromTest = createRequire(import.meta.url);
const TSX_IMPORT = requireFromTest.resolve("tsx");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function expectedMcpServerArgs(params: { sourceEntry: string; distEntry: string }): string[] {
  const distEntry = path.resolve(params.distEntry);
  if (fs.existsSync(distEntry)) {
    return [distEntry];
  }
  return ["--import", TSX_IMPORT, path.resolve(params.sourceEntry)];
}

describe("embedded acpx plugin config", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("resolves state independently of the session working directory", () => {
    const workspaceDir = path.resolve("/tmp/openclaw-acpx");
    const stateDir = path.resolve("/tmp/openclaw-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const resolved = resolveAcpxPluginConfig({
      rawConfig: undefined,
      workspaceDir,
    });

    expect(resolved.cwd).toBe(workspaceDir);
    expect(resolved.stateDir).toBe(path.join(stateDir, "acpx"));
    expect(resolved.permissionMode).toBe("approve-reads");
    expect(resolved.nonInteractivePermissions).toBe("fail");
    expect(resolved.timeoutSeconds).toBe(120);
    expect(resolved.probeAgent).toBeUndefined();
    expect(resolved.agents).toStrictEqual({});
    expect(
      resolveAcpxPluginConfig({ rawConfig: { stateDir: workspaceDir }, stateDir }).stateDir,
    ).toBe(workspaceDir);
    expect(resolveAcpxPluginConfig({ rawConfig: {}, stateDir: workspaceDir }).stateDir).toBe(
      path.join(workspaceDir, "acpx"),
    );
  });

  it("accepts agent command overrides", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          claude: { command: "claude --acp" },
          codex: { command: "codex custom-acp" },
        },
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    expect(resolved.agents).toEqual({
      claude: ["claude", "--acp"],
      codex: ["codex", "custom-acp"],
    });
  });

  it.each([
    {
      platform: "win32",
      command: String.raw`.\agent.exe --stdio`,
      expected: [String.raw`.\agent.exe`, "--stdio"],
    },
    {
      platform: "win32",
      command: String.raw`node C:\tools\agent.js`,
      expected: ["node", String.raw`C:\tools\agent.js`],
    },
    {
      platform: "win32",
      command: String.raw`"\\server\share\agent.exe" "" "C:\work dir\\"`,
      expected: [String.raw`\\server\share\agent.exe`, "", "C:\\work dir\\"],
    },
    {
      platform: "win32",
      command: String.raw`node "say \"hello\""`,
      expected: ["node", 'say "hello"'],
    },
    {
      platform: "linux",
      command: String.raw`node ./some\ file.js ""`,
      expected: ["node", "./some file.js", ""],
    },
  ] as const)("preserves $platform command syntax: $command", ({ platform, command, expected }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const config = resolveAcpxPluginConfig({
      rawConfig: { agents: { fixture: { command, args: ["suffix"] } } },
      workspaceDir: "/tmp/openclaw-acpx",
    });
    expect(config.agents.fixture).toEqual([...expected, "suffix"]);
  });

  it("preserves structured agent args without shell quoting", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          custom: {
            command: "node",
            args: ["/tmp/My Adapter.mjs", "--flag=value with spaces", "owner's-choice"],
          },
        },
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    expect(resolved.agents).toEqual({
      custom: ["node", "/tmp/My Adapter.mjs", "--flag=value with spaces", "owner's-choice"],
    });
  });

  it("rejects incomplete command quoting before creating launch argv", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: { agents: { custom: { command: "node 'unfinished argument" } } },
        workspaceDir: "/tmp/openclaw-acpx",
      }),
    ).toThrow("unterminated quote");
  });

  it("carries an explicit probeAgent through to the resolved plugin config, trimmed", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        probeAgent: "  OpenCode  ",
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    expect(resolved.probeAgent).toBe("OpenCode");
  });

  it("rejects an empty probeAgent string", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          probeAgent: "",
        },
        workspaceDir: "/tmp/openclaw-acpx",
      }),
    ).toThrow(/probeAgent must be a non-empty string/);
  });

  it("injects the built-in plugin-tools MCP server only when explicitly enabled", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        pluginToolsMcpBridge: true,
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    const server = resolved.mcpServers["openclaw-plugin-tools"];
    expect(server).toEqual({
      command: process.execPath,
      args: expectedMcpServerArgs({
        sourceEntry: "src/mcp/plugin-tools-serve.ts",
        distEntry: "dist/mcp/plugin-tools-serve.js",
      }),
    });
  });

  it("injects the built-in OpenClaw tools MCP server only when explicitly enabled", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        openClawToolsMcpBridge: true,
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    const server = resolved.mcpServers["openclaw-tools"];
    expect(server).toEqual({
      command: process.execPath,
      args: expectedMcpServerArgs({
        sourceEntry: "src/mcp/openclaw-tools-serve.ts",
        distEntry: "dist/mcp/openclaw-tools-serve.js",
      }),
    });
  });

  it("launches managed bridges from the host package when acpx is an external package", () => {
    const tmp = fs.realpathSync(tempDirs.make("openclaw-acpx-external-"));
    const hostRoot = path.join(tmp, "lib", "node_modules", "openclaw");
    fs.mkdirSync(path.join(hostRoot, "dist", "mcp"), { recursive: true });
    fs.writeFileSync(path.join(hostRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
    fs.writeFileSync(path.join(hostRoot, "openclaw.mjs"), "");
    fs.writeFileSync(path.join(hostRoot, "dist", "mcp", "plugin-tools-serve.js"), "");
    fs.writeFileSync(path.join(hostRoot, "dist", "mcp", "openclaw-tools-serve.js"), "");
    fs.mkdirSync(path.join(tmp, "bin"));
    fs.symlinkSync(path.join(hostRoot, "openclaw.mjs"), path.join(tmp, "bin", "openclaw"));
    const pluginRoot = path.join(tmp, "captures", "package-0", "node_modules", "@openclaw", "acpx");
    fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ name: "@openclaw/acpx" }),
    );
    fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "{}");
    const originalArgv = process.argv;
    process.argv = [process.execPath, path.join(tmp, "bin", "openclaw"), "gateway"];
    try {
      const resolved = resolveAcpxPluginConfig({
        rawConfig: { pluginToolsMcpBridge: true, openClawToolsMcpBridge: true },
        workspaceDir: "/tmp/openclaw-acpx",
        moduleUrl: pathToFileURL(path.join(pluginRoot, "dist", "config.js")).href,
      });

      expect(resolved.mcpServers).toEqual({
        "openclaw-plugin-tools": {
          command: process.execPath,
          args: [path.join(hostRoot, "dist", "mcp", "plugin-tools-serve.js")],
        },
        "openclaw-tools": {
          command: process.execPath,
          args: [path.join(hostRoot, "dist", "mcp", "openclaw-tools-serve.js")],
        },
      });
    } finally {
      process.argv = originalArgv;
    }
  });

  it("resolves the plugin root from shared dist chunk paths", () => {
    const moduleUrl = new URL("../../../dist/extensions/acpx/service-shared.js", import.meta.url)
      .href;

    expect(resolveAcpxPluginRoot(moduleUrl)).toBe(path.resolve("extensions/acpx"));
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    const pluginRoot = resolveAcpxPluginRoot();
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
    ) as { configSchema?: unknown };

    expect(buildPluginConfigSchema(AcpxPluginConfigSchema).jsonSchema).toEqual(
      manifest.configSchema,
    );
  });
});
