import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BundleMcpConfig } from "../plugins/bundle-mcp.types.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  buildCodexMcpServersConfig,
  loadCodexBundleMcpApprovalConfig,
  loadCodexBundleMcpThreadConfigCore,
} from "./codex-mcp-config.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";

const mocks = vi.hoisted(() => ({
  loadExecApprovalsReadOnlyAsync: vi.fn(),
  bundleMcp: { config: { mcpServers: {} }, diagnostics: [] },
}));
const tempDirs: string[] = [];
function setServers(mcpServers: BundleMcpConfig["mcpServers"]) {
  mocks.bundleMcp.config.mcpServers = mcpServers;
}
function load(
  params: Omit<Parameters<typeof loadCodexBundleMcpThreadConfigCore>[0], "workspaceDir"> = {},
) {
  return loadCodexBundleMcpThreadConfigCore({ workspaceDir: "/workspace", ...params });
}
type Config = NonNullable<NonNullable<Parameters<typeof load>[0]>["cfg"]>;
const configured = (servers: NonNullable<Config["mcp"]>["servers"]): Config => ({
  mcp: { servers },
});
const http = (url: string, options: Record<string, unknown> = {}) => ({
  type: "http",
  url,
  ...options,
});

vi.mock("../infra/exec-approvals-store.js", () => ({
  loadExecApprovalsReadOnlyAsync: mocks.loadExecApprovalsReadOnlyAsync,
}));

// mock-isolation: Supply bundle MCP configuration without loading plugin runtimes.
vi.mock("../plugins/bundle-mcp.js", () => ({
  loadEnabledBundleMcpConfig: () => mocks.bundleMcp,
}));

beforeEach(() => {
  mocks.loadExecApprovalsReadOnlyAsync.mockReset().mockResolvedValue({ version: 1, agents: {} });
  mocks.bundleMcp = { config: { mcpServers: {} }, diagnostics: [] };
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildCodexMcpServersConfig", () => {
  it("normalizes OpenClaw MCP servers into Codex app-server mcp_servers shape", () => {
    expect(
      buildCodexMcpServersConfig({
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            connectionTimeoutMs: 12_345,
            requestTimeoutMs: 20_125,
            supportsParallelToolCalls: true,
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
              "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
              "x-static": "static-value",
            },
          },
        },
      }),
    ).toEqual({
      openclaw: {
        url: "http://127.0.0.1:23119/mcp",
        startup_timeout_sec: 12.345,
        tool_timeout_sec: 20.125,
        supports_parallel_tool_calls: true,
        default_tools_approval_mode: "approve",
        bearer_token_env_var: "OPENCLAW_MCP_TOKEN",
        http_headers: { "x-static": "static-value" },
        env_http_headers: { "x-session-key": "OPENCLAW_MCP_SESSION_KEY" },
      },
    });
  });

  it("keeps native timeout projection within OpenClaw timer bounds", () => {
    expect(
      buildCodexMcpServersConfig({
        mcpServers: {
          bounded: { command: "mcp", connectionTimeoutMs: 0.25, requestTimeoutMs: 1e306 },
          defaults: { command: "mcp" },
        },
      }),
    ).toEqual({
      bounded: { command: "mcp", startup_timeout_sec: 0.001, tool_timeout_sec: 2_147_000 },
      defaults: { command: "mcp" },
    });
  });
});

describe("loadCodexBundleMcpThreadConfigCore", () => {
  it("projects durable grants only for configured bundle names and fingerprints their removal", async () => {
    setServers({
      configured: { command: "mcp" },
      prompt: { command: "mcp" },
      pluginOnly: { command: "mcp" },
    });
    mocks.loadExecApprovalsReadOnlyAsync.mockResolvedValue({
      version: 1,
      agents: {
        main: {
          mcpTools: ["configured", "prompt", "pluginOnly"].map((server) => ({
            server,
            tool: "write.raw_tool",
            source: "allow-always",
            addedAt: 1,
          })),
        },
      },
    });
    const params = {
      agentId: "main",
      cfg: configured({
        configured: { command: "mcp" },
        prompt: { command: "mcp", codex: { defaultToolsApprovalMode: "prompt" } },
      }),
    };

    const granted = await load(params);

    expect(granted.configPatch?.mcp_servers).toEqual({
      configured: { command: "mcp", tools: { "write.raw_tool": { approval_mode: "approve" } } },
      prompt: { command: "mcp" },
      pluginOnly: { command: "mcp" },
    });
    expect(mocks.loadExecApprovalsReadOnlyAsync).toHaveBeenCalledTimes(1);
    mocks.loadExecApprovalsReadOnlyAsync.mockResolvedValue({ version: 1, agents: {} });
    const revoked = await load(params);
    expect(revoked.configPatch?.mcp_servers.configured).not.toHaveProperty("tools");
    expect(revoked.fingerprint).not.toBe(granted.fingerprint);
  });

  it("prepares Agent Plugins data dirs before projecting Codex thread config", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-agent-mcp-"));
    tempDirs.push(tempDir);
    const dataDir = path.join(tempDir, "plugin-data");
    const collisionPath = path.join(tempDir, "plugin-data-collision");
    await fs.writeFile(collisionPath, "not a directory", "utf8");
    setServers({
      weather: {
        command: "node",
        env: { PLUGIN_DATA: dataDir },
        supportsParallelToolCalls: false,
        codex: { defaultToolsApprovalMode: "prompt" },
      },
      broken: { command: "node", env: { PLUGIN_DATA: collisionPath } },
    });
    Object.assign(mocks.bundleMcp, {
      prepareDataDirsByServer: {
        weather: { pluginId: "weather-plugin", dataDir },
        broken: { pluginId: "broken-plugin", dataDir: collisionPath },
      },
    });

    expect(loadCodexBundleMcpApprovalConfig({ workspaceDir: "/workspace" })).toEqual({
      weather: { default_tools_approval_mode: "prompt" },
      broken: { default_tools_approval_mode: undefined },
    });
    await expect(fs.stat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
    const loaded = await load();

    expect((await fs.stat(dataDir)).isDirectory()).toBe(true);
    expect(loaded.configPatch?.mcp_servers.weather).toMatchObject({
      command: "node",
      supports_parallel_tool_calls: false,
      default_tools_approval_mode: "prompt",
    });
    expect(loaded.configPatch?.mcp_servers.broken).toBeUndefined();
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        pluginId: "broken-plugin",
        message: expect.stringMatching(/unable to prepare PLUGIN_DATA.*EEXIST/iu),
      }),
    ]);
  });

  it("loads enabled bundled MCP servers as a Codex thread config patch", async () => {
    const search = {
      url: "https://mcp.example.com/mcp",
      connectionTimeoutMs: 12_345,
      requestTimeoutMs: 20_125,
      supportsParallelToolCalls: true,
    };
    setServers({ search: { type: "http", ...search } });

    const loaded = await load({
      cfg: { plugins: { entries: { "bundle-probe": { enabled: true } } } },
    });

    expect(loaded.configPatch).toEqual({
      mcp_servers: {
        search: {
          url: "https://mcp.example.com/mcp",
          startup_timeout_sec: 12.345,
          tool_timeout_sec: 20.125,
          supports_parallel_tool_calls: true,
        },
      },
    });
    expect(loaded.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.staticServerNames).toEqual(["search"]);
    for (const changedControls of [
      { connectionTimeoutMs: 25_000 },
      { requestTimeoutMs: 45_000 },
      { supportsParallelToolCalls: false },
    ]) {
      setServers({ search: { ...search, ...changedControls } });
      const changed = await load();
      expect(changed.fingerprint).not.toBe(loaded.fingerprint);
    }
  });

  it("applies session server and tool denials to bundled Codex MCP config", async () => {
    setServers({
      docs: http("https://docs.example.com/mcp", { toolFilter: { exclude: ["delete_all"] } }),
      constructor: http("https://constructor.example.com/mcp"),
      search: http("https://search.example.com/mcp"),
    });

    const loaded = await load({
      cfg: {},
      toolOverrides: {
        mcpServers: { search: false },
        mcpToolsDeny: { docs: ["delete_page"] },
      },
    });

    expect(loaded.configPatch).toEqual({
      mcp_servers: {
        constructor: { url: "https://constructor.example.com/mcp" },
        docs: {
          url: "https://docs.example.com/mcp",
          disabled_tools: ["delete_all", "delete_page"],
        },
      },
    });
  });

  it("lets user config disable a same-named bundled server unless the session enables it", async () => {
    setServers({ docs: http("https://bundled.example.com/mcp") });
    const cfg = configured({ docs: { enabled: false, url: "https://configured.example.com/mcp" } });

    expect((await load({ cfg })).configPatch).toBeUndefined();
    expect(
      (
        await load({
          cfg,
          toolOverrides: { mcpServers: { docs: true } },
        })
      ).configPatch,
    ).toEqual({
      mcp_servers: {
        docs: { url: "https://bundled.example.com/mcp" },
      },
    });
  });

  it("returns an evaluated empty MCP config when no bundle MCP runtime is needed", async () => {
    const cfg = configured({
      search: { transport: "streamable-http", url: "https://mcp.example.com/mcp" },
    });

    for (const params of [
      { toolsEnabled: false },
      { toolsEnabled: true, disableTools: true },
      { toolsEnabled: true, toolsAllow: [] },
      { toolsEnabled: true, toolsAllow: ["memory_search"] },
    ]) {
      const loaded = await load({ cfg, ...params });

      expect(loaded.configPatch).toBeUndefined();
      expect(loaded.fingerprint).toBeUndefined();
      expect(loaded.evaluated).toBe(true);
      expect(loaded.staticServerNames).toEqual([]);
    }
  });

  it("excludes requester-scoped servers from projection and fingerprint", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "user-mail",
        resolve: async () => ({ url: "https://should-never-project.example/mcp" }),
      });
      const search = http("https://mcp.example.com/mcp");
      setServers({ search, "user-mail": http("https://unresolved.invalid") });

      const loaded = await load({ cfg: {}, toolsEnabled: true });
      setServers({ search });
      const withoutScopedConfig = await load({ cfg: {}, toolsEnabled: true });

      expect(loaded.configPatch).toEqual({
        mcp_servers: { search: { url: "https://mcp.example.com/mcp" } },
      });
      expect(JSON.stringify(loaded.configPatch)).not.toContain("unresolved.invalid");
      expect(JSON.stringify(loaded.configPatch)).not.toContain("user-mail");
      expect(loaded.configPatch).toEqual(withoutScopedConfig.configPatch);
      expect(loaded.fingerprint).toBe(withoutScopedConfig.fingerprint);
      expect(loaded.staticServerNames).toEqual(["search"]);
    });
  });
});
