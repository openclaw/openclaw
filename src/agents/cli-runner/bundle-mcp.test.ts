import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../config/types.mcp.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveBundlePluginRoot,
  writeBundleTextFiles,
} from "../../plugins/bundle-mcp.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveCliSessionReuse } from "../cli-session.js";
import {
  type CliMcpParams,
  loopbackConfig,
  policyConfig,
  prepareMcp as prepareCliBundleMcpConfig,
  readMcpConfig as readConfig,
  trackMcpPreparation,
  userMcpConfig,
} from "./bundle-mcp-fixtures.test-support.js";
import { prepareCliBundleMcpCaptureAttempt } from "./bundle-mcp.js";
import {
  cliBundleMcpHarness,
  cliNativeMcpPolicyContext,
  prepareBundleProbeCliConfig as prepareProbe,
  requireMcpConfigPath,
  setupCliBundleMcpTestHarness,
} from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

const prepareBundleProbeCliConfig = (params: Parameters<typeof prepareProbe>[0]) =>
  trackMcpPreparation(prepareProbe(params));
const prepareClaudeConfig = (params: Partial<CliMcpParams>) =>
  prepareCliBundleMcpConfig({ mode: "claude-config-file", ...params });

const nodeServer = (script: string) => ({ command: "node", args: [script] });
const writeServers = (filePath: string, mcpServers: Record<string, McpServerConfig>) =>
  fs.writeFile(filePath, JSON.stringify({ mcpServers }), "utf-8");

async function preparePolicy(
  sessionId: string,
  options: {
    tools?: OpenClawConfig["tools"];
    server?: McpServerConfig;
    runtimeToolsAllow?: string[];
  } & Partial<CliMcpParams> = {},
) {
  const { tools, server, runtimeToolsAllow, ...params } = options;
  const config = await policyConfig({ tools, server });
  return prepareClaudeConfig({
    backend: { command: "claude", args: ["--print"] },
    config,
    nativeMcpPolicy: { ...cliNativeMcpPolicyContext(config, sessionId), runtimeToolsAllow },
    ...params,
  });
}

function expectDocsDenied(args: string[] | undefined) {
  expect(args?.join(",")).toEqual(expect.stringContaining("mcp__docs__delete_docs"));
  expect(args?.join(",")).toEqual(expect.stringContaining("mcp__docs__task_docs"));
  expect(args?.join(",")).toEqual(expect.stringContaining("mcp__docs__app_docs"));
}

describe("prepareCliBundleMcpConfig", () => {
  it("disables Claude native web search without bundle MCP", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: false,
      mode: "claude-config-file",
      backend: { command: "claude", args: ["--print"] },
      workspaceDir: "/tmp/openclaw-cli-web-search-disabled",
      toolOverrides: { webSearch: false },
    });

    expect(prepared.backend.args).toEqual(["--print", "--disallowedTools", "WebSearch"]);
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serves only the exclusive config, ignoring user and plugin servers", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-exclusive-",
    );
    const userConfig = path.join(workspaceDir, "user-mcp.json");
    await writeServers(userConfig, { user: nodeServer("user.mjs") });

    const prepared = await prepareClaudeConfig({
      backend: {
        command: "node",
        args: ["./fake-claude.mjs", "--mcp-config", "user-mcp.json"],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
      exclusiveConfig: {
        mcpServers: { openclaw: nodeServer("openclaw.mjs") },
      },
    });

    expect(prepared.backend.args).toContain("--strict-mcp-config");
    const raw = await readConfig(prepared);
    expect(Object.keys(raw.mcpServers ?? {})).toEqual(["openclaw"]);
    expect(raw.mcpServers?.openclaw?.args).toEqual(["openclaw.mjs"]);
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("carries Agent Plugins data-dir and transport contracts into external projections", async () => {
    const pluginId = "agent-cli-projection";
    const pluginRoot = resolveBundlePluginRoot(cliBundleMcpHarness.bundleProbeHomeDir, pluginId);
    await writeBundleTextFiles(pluginRoot, {
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: pluginId,
      }),
      "mcp.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          local: { type: "stdio", command: "node" },
          remote: { type: "streamable-http", url: "https://example.test/mcp" },
          legacy: { type: "sse", url: "https://example.test/sse" },
        },
      }),
    });
    const agentDataDir = path.join(
      cliBundleMcpHarness.bundleProbeHomeDir,
      ".openclaw/plugin-data",
      pluginId,
    );
    const userDataPath = path.join(
      cliBundleMcpHarness.bundleProbeHomeDir,
      "user-data-must-not-exist",
    );
    clearPluginMetadataLifecycleCaches();

    const prepared = await withEnvAsync(
      { HOME: cliBundleMcpHarness.bundleProbeHomeDir },
      async () =>
        await prepareCliBundleMcpConfig({
          mode: "gemini-system-settings",
          backend: { command: "gemini" },
          workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
          config: userMcpConfig(
            {
              user: {
                command: "node",
                env: { PLUGIN_ROOT: "/user/plugin", PLUGIN_DATA: userDataPath },
              },
            },
            { plugins: { entries: { [pluginId]: { enabled: true } } } },
          ),
        }),
    );

    expect((await fs.stat(agentDataDir)).isDirectory()).toBe(true);
    await expect(fs.stat(userDataPath)).rejects.toMatchObject({ code: "ENOENT" });
    const raw = await readConfig(prepared, true);
    expect(raw.mcpServers?.remote).toMatchObject({
      type: "http",
      url: "https://example.test/mcp",
    });
    expect(raw.mcpServers?.legacy).toMatchObject({
      type: "sse",
      url: "https://example.test/sse",
    });
    expect(raw.mcpServers?.remote?.transport).toBeUndefined();
    expect(raw.mcpServers?.legacy?.transport).toBeUndefined();
    await fs.rm(pluginRoot, { recursive: true, force: true });
    clearPluginMetadataLifecycleCaches();
  });

  it("projects normalized session MCP denials alongside existing Claude denials", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-deny-",
    );
    const prepared = await prepareClaudeConfig({
      backend: {
        command: "claude",
        args: ["--disallowedTools=Bash(rm *)"],
      },
      workspaceDir,
      config: userMcpConfig({ "docs.prod": nodeServer("docs.mjs") }),
      toolOverrides: {
        mcpToolsDeny: { "docs.prod": ["read.value", "read:value"] },
        webSearch: false,
      },
    });

    expect(prepared.backend.args).toEqual([
      "--strict-mcp-config",
      "--mcp-config",
      requireMcpConfigPath(prepared.backend.args),
      "--disallowedTools",
      "Bash(rm *),WebSearch,mcp__docs_prod__read_value",
    ]);
    expect(prepared.backend.resumeArgs).toEqual(prepared.backend.args);
  });

  it("projects durable policy into the first Claude process config and argv", async () => {
    const prepared = await preparePolicy("claude-policy", {
      tools: { allow: ["docs__*"], deny: ["docs__delete_docs"] },
      additionalConfig: {
        mcpServers: { openclaw: { url: "http://127.0.0.1:31783/mcp" } },
      },
      toolOverrides: { mcpToolsDeny: { openclaw: ["message"] } },
    });

    expectDocsDenied(prepared.backend.args);
    expect(prepared.backend.args?.join(",")).toContain("mcp__openclaw__message");
    const raw = await readConfig(prepared);
    expect(Object.keys(raw.mcpServers ?? {})).toEqual(["docs", "openclaw"]);
    expect(raw.mcpServers?.docs?.toolFilter).toBeUndefined();
  });

  it.each<[string, NonNullable<Parameters<typeof preparePolicy>[1]>]>([
    ["claude-configured-filter", { server: { toolFilter: { include: ["read_*"] } } }],
    ["claude-runtime-cap", { runtimeToolsAllow: ["docs__read_docs"] }],
  ])("projects restrictive Claude tool visibility (%s)", async (sessionId, options) => {
    const prepared = await preparePolicy(sessionId, options);
    expectDocsDenied(prepared.backend.args);
    expect(prepared.backend.args?.join(",")).not.toContain("mcp__docs__read_docs");
  });

  it.each<[string, NonNullable<Parameters<typeof preparePolicy>[1]>]>([
    ["claude-policy-empty", { tools: { allow: ["missing__tool"] } }],
    [
      "claude-policy-catalog-failure",
      { tools: { deny: ["docs__delete_docs"] }, server: { args: ["-e", "process.exit(1)"] } },
    ],
  ])(
    "omits Claude servers denied by policy or missing a catalog (%s)",
    async (sessionId, options) => {
      const prepared = await preparePolicy(sessionId, options);
      expect((await readConfig(prepared)).mcpServers).toEqual({});
    },
  );

  it("applies server disables to exclusive CLI MCP configs", async () => {
    const prepared = await prepareClaudeConfig({
      backend: { command: "claude" },
      workspaceDir: "/tmp/openclaw-cli-bundle-mcp-exclusive-disable",
      exclusiveConfig: { mcpServers: { openclaw: { command: "node" } } },
      toolOverrides: { mcpServers: { openclaw: false } },
    });

    expect((await readConfig(prepared)).mcpServers).toEqual({});
  });

  it("strips variadic Claude --mcp-config values and merges every listed config", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-variadic-",
    );
    await writeServers(path.join(workspaceDir, "first-mcp.json"), {
      first: nodeServer("first.mjs"),
      shared: nodeServer("old.mjs"),
    });
    await writeServers(path.join(workspaceDir, "second-mcp.json"), {
      second: nodeServer("second.mjs"),
      shared: nodeServer("new.mjs"),
    });

    const prepared = await prepareClaudeConfig({
      backend: {
        command: "node",
        args: [
          "./fake-claude.mjs",
          "--mcp-config",
          "first-mcp.json",
          "second-mcp.json",
          "--verbose",
        ],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
    });

    expect(prepared.backend.args).not.toContain("first-mcp.json");
    expect(prepared.backend.args).not.toContain("second-mcp.json");
    expect(prepared.backend.args).toContain("--verbose");
    const raw = await readConfig(prepared);
    expect(raw.mcpServers).toMatchObject({
      first: { args: ["first.mjs"] },
      second: { args: ["second.mjs"] },
      shared: { args: ["new.mjs"] },
    });
  });

  it("merges loopback overlay config with bundle MCP servers", async () => {
    const additionalConfig = loopbackConfig({
      headers: {
        Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
        "x-openclaw-cli-capture-key": "${OPENCLAW_MCP_CLI_CAPTURE_KEY}",
      },
    });
    const prepare = (token: string) =>
      prepareBundleProbeCliConfig({
        additionalConfig,
        env: { OPENCLAW_MCP_TOKEN: token, OPENCLAW_MCP_CLI_CAPTURE_KEY: "" },
      });
    const prepared = await prepare("lb-tk-123");
    const otherEnvPrepared = await prepare("other-loopback-token");

    const raw = await readConfig(prepared);
    expect(prepared.backend.args).toContain("--strict-mcp-config");
    expect(raw.mcpServers?.bundleProbe?.args).toEqual([
      await fs.realpath(cliBundleMcpHarness.bundleProbeServerPath),
    ]);
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.mcpResumeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(raw.mcpServers ?? {}).toSorted()).toEqual(["bundleProbe", "openclaw"]);
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer lb-tk-123");
    expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-cli-capture-key"]).toBe("");
    await prepareCliBundleMcpCaptureAttempt({
      preparedBackend: prepared,
      captureKey: "attempt-123",
    });
    const attemptRaw = await readConfig(prepared);
    expect(attemptRaw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer lb-tk-123");
    expect(attemptRaw.mcpServers?.openclaw?.headers?.["x-openclaw-cli-capture-key"]).toBe(
      "attempt-123",
    );
    expect(prepared.mcpConfigHash).toBe(otherEnvPrepared.mcpConfigHash);
    expect(prepared.mcpResumeHash).toBe(otherEnvPrepared.mcpResumeHash);
  });

  it("leaves args untouched when bundle MCP is disabled", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: false,
      backend: {
        command: "node",
        args: ["./fake-cli.mjs"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-disabled",
    });

    expect(prepared.backend.args).toEqual(["./fake-cli.mjs"]);
    expect(prepared.cleanup).toBeUndefined();
  });
});

type SearchConfig = NonNullable<NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"]>;

async function prepareSearchConfig(
  mode: "claude-config-file" | "codex-config-overrides",
  search?: SearchConfig,
  enabled = true,
) {
  const prepared = await prepareCliBundleMcpConfig({
    enabled,
    mode,
    backend: { command: "fixture-cli", args: ["run"], resumeArgs: ["resume"] },
    workspaceDir: "/synthetic/cli-search",
    config: { plugins: { enabled: false }, tools: { web: { search } } },
    exclusiveConfig: {
      mcpServers: { openclaw: { type: "http", url: "http://127.0.0.1:12345/mcp" } },
    },
    env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: "" },
  });
  return prepared;
}

it("disables pinned Codex search while preserving the managed MCP server", async () => {
  const prepared = await prepareSearchConfig("codex-config-overrides", {
    provider: "parallel-free",
  });
  expect(prepared.backend.args).toContain('web_search="disabled"');
  expect(prepared.backend.resumeArgs).toContain('web_search="disabled"');
  const servers = prepared.backend.args?.find((arg) => arg.startsWith("mcp_servers="));
  expect(servers).toContain("openclaw");
  expect(servers).not.toContain("disabled_tools");
});

it("invalidates a native search session when its search provider is pinned", async () => {
  const automatic = await prepareSearchConfig("claude-config-file");
  const pinned = await prepareSearchConfig("claude-config-file", { provider: "brave" });
  expect(automatic.backend.args).not.toContain("--disallowedTools");
  expect(automatic.mcpResumeHash).not.toBe(pinned.mcpResumeHash);
  expect(
    resolveCliSessionReuse({
      binding: {
        sessionId: "native-session",
        mcpResumeHash: automatic.mcpResumeHash,
        authEpochVersion: 1,
      },
      authEpochVersion: 1,
      mcpResumeHash: pinned.mcpResumeHash,
    }),
  ).toMatchObject({ mode: "invalidate", invalidatedReason: "mcp" });
});

it("enforces an explicit search provider without bundle MCP", async () => {
  const prepared = await prepareSearchConfig(
    "codex-config-overrides",
    { provider: "brave" },
    false,
  );
  expect(prepared.backend.args).toContain('web_search="disabled"');
});

it("adapts opted-in bundle MCP to Claude by default", async () => {
  const prepared = await prepareCliBundleMcpConfig({
    enabled: true,
    backend: { command: "custom-cli", args: ["run"] },
    workspaceDir: "/synthetic/cli-search",
    config: { tools: { web: { search: { provider: "brave" } } } },
    exclusiveConfig: { mcpServers: {} },
  });
  const args = prepared.backend.args ?? [];
  expect(args[args.indexOf("--disallowedTools") + 1]?.split(",")).toContain("WebSearch");
});
