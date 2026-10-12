// ACPX tests cover config plugin behavior.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAcpxPluginConfig, resolveAcpxPluginRoot } from "./config.js";

const requireFromTest = createRequire(import.meta.url);
const TSX_IMPORT = requireFromTest.resolve("tsx");

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

  it.each([
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

  it("rejects incomplete command quoting before creating launch argv", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: { agents: { custom: { command: "node 'unfinished argument" } } },
        workspaceDir: "/tmp/openclaw-acpx",
      }),
    ).toThrow("unterminated quote");
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

  it("resolves the plugin root from shared dist chunk paths", () => {
    const moduleUrl = new URL("../../../dist/extensions/acpx/service-shared.js", import.meta.url)
      .href;

    expect(resolveAcpxPluginRoot(moduleUrl)).toBe(path.resolve("extensions/acpx"));
  });
});
