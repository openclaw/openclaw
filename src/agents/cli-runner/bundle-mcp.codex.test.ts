/** Tests Codex CLI bundle-MCP config override generation. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildSystemAgentToolsMcpServerConfig } from "../../mcp/openclaw-tools-serve-config.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { retireSessionMcpRuntime } from "../agent-bundle-mcp-manager-api.js";
import { resolveCliSessionReuse } from "../cli-session.js";
import { AuthStorage } from "../sessions/auth-storage.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { buildCodexUserMcpServersThreadConfigPatchForRun } from "./bundle-mcp-codex.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  cliBundleMcpHarness,
  cliNativeMcpPolicyContext,
  prepareBundleProbeCliConfig,
  setupCliBundleMcpTestHarness,
  writeCliMcpPolicyProbeServer,
} from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

describe("prepareCliBundleMcpConfig codex", () => {
  it.each([
    ["agent:worker:policy", undefined],
    ["global", "worker"],
  ] as const)(
    "keeps Codex server ownership separate from the runtime policy owner (%s)",
    async (sandboxSessionKey, sandboxAgentId) => {
      const serverPath = await writeCliMcpPolicyProbeServer();
      const workspaceDir = cliBundleMcpHarness.bundleProbeWorkspaceDir;
      const sessionId = "codex-independent-policy-owner";
      const config: OpenClawConfig = {
        plugins: { enabled: false },
        agents: {
          entries: { main: {}, worker: { tools: { deny: ["docs__delete_docs"] } } },
        },
        mcp: {
          servers: {
            docs: { command: process.execPath, args: [serverPath], codex: { agents: ["main"] } },
          },
        },
      };
      const authStorage = AuthStorage.inMemory();
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: cliBundleMcpHarness.bundleProbeHomeDir },
        async () => {
          try {
            const patch = await buildCodexUserMcpServersThreadConfigPatchForRun({
              cwd: workspaceDir,
              run: {
                agentId: "main",
                sessionId,
                sessionKey: "agent:main:conversation",
                sandboxSessionKey,
                sandboxAgentId,
                sessionFile: "agent:main:conversation",
                workspaceDir,
                config,
                prompt: "hello",
                timeoutMs: 1_000,
                runId: sessionId,
                provider: "openai",
                modelId: "gpt-5.6-luna",
                model: {
                  id: "gpt-5.6-luna",
                  name: "Test model",
                  api: "openai-responses",
                  provider: "openai",
                  baseUrl: "https://api.openai.com/v1",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 100_000,
                  maxTokens: 1_000,
                },
                authStorage,
                authProfileStore: { version: 1, profiles: {} },
                modelRegistry: ModelRegistry.inMemory(authStorage),
                thinkLevel: "off",
              },
            });
            expect(patch?.mcp_servers.docs).toMatchObject({
              enabled_tools: ["read_docs"],
              disabled_tools: ["app_docs", "delete_docs", "task_docs"],
            });
          } finally {
            await retireSessionMcpRuntime({ sessionId, reason: "test-complete" });
          }
        },
      );
    },
  );

  it("disables Codex native web search without bundle MCP", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: false,
      mode: "codex-config-overrides",
      backend: { command: "codex", args: ["exec"] },
      workspaceDir: "/tmp/openclaw-cli-codex-web-search-disabled",
      toolOverrides: { webSearch: false },
    });

    expect(prepared.backend.args).toEqual(["exec", "-c", 'web_search="disabled"']);
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("projects session MCP tool denials into Codex disabled_tools", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "codex-config-overrides",
      backend: { command: "codex", args: ["exec"] },
      workspaceDir: "/tmp/openclaw-bundle-mcp-codex-deny",
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            docs: { transport: "streamable-http", url: "https://docs.example.com/mcp" },
          },
        },
      },
      toolOverrides: { mcpToolsDeny: { docs: ["delete_docs"] }, webSearch: false },
    });

    expect(prepared.backend.args?.find((arg) => arg.startsWith("mcp_servers="))).toContain(
      'disabled_tools = ["delete_docs"]',
    );
    expect(prepared.backend.args).toContain('web_search="disabled"');
  });

  it("projects configured wildcard filters as exact Codex CLI overrides", async () => {
    const serverPath = await writeCliMcpPolicyProbeServer();
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      tools: { allow: ["docs__*"] },
      mcp: {
        servers: {
          docs: {
            command: process.execPath,
            args: [serverPath],
            toolFilter: { exclude: ["delete_*"] },
          },
        },
      },
    };
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "codex-config-overrides",
      backend: { command: "codex", args: ["exec"] },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      config,
      nativeMcpPolicy: cliNativeMcpPolicyContext(config, "codex-cli-policy"),
    });
    const override = prepared.backend.args?.find((arg) => arg.startsWith("mcp_servers="));
    expect(override).toContain('enabled_tools = ["read_docs"]');
    expect(override).toContain('disabled_tools = ["app_docs", "delete_docs", "task_docs"]');
    expect(override).not.toContain("delete_*");
  });

  it("injects codex MCP config overrides with env-backed loopback headers", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "codex-config-overrides",
      backend: {
        command: "codex",
        args: ["exec", "--json"],
        resumeArgs: ["exec", "resume", "{sessionId}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-codex",
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
              "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
              "x-openclaw-cli-capture-key": "${OPENCLAW_MCP_CLI_CAPTURE_KEY}",
            },
          },
        },
      },
    });

    // Codex consumes MCP config through TOML-like -c overrides instead of a
    // generated config file.
    expect(prepared.backend.args).toEqual([
      "exec",
      "--json",
      "-c",
      'mcp_servers={ openclaw = { url = "http://127.0.0.1:23119/mcp", default_tools_approval_mode = "approve", bearer_token_env_var = "OPENCLAW_MCP_TOKEN", env_http_headers = { x-session-key = "OPENCLAW_MCP_SESSION_KEY", x-openclaw-cli-capture-key = "OPENCLAW_MCP_CLI_CAPTURE_KEY" } } }',
    ]);
    expect(prepared.backend.resumeArgs).toEqual([
      "exec",
      "resume",
      "{sessionId}",
      "-c",
      'mcp_servers={ openclaw = { url = "http://127.0.0.1:23119/mcp", default_tools_approval_mode = "approve", bearer_token_env_var = "OPENCLAW_MCP_TOKEN", env_http_headers = { x-session-key = "OPENCLAW_MCP_SESSION_KEY", x-openclaw-cli-capture-key = "OPENCLAW_MCP_CLI_CAPTURE_KEY" } } }',
    ]);
    expect(prepared.cleanup).toBeUndefined();
  });
});

function prepareLoopbackConfig(url: string) {
  return prepareBundleProbeCliConfig({
    additionalConfig: {
      mcpServers: {
        openclaw: {
          type: "http",
          url,
          headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
        },
      },
    },
  });
}

describe("prepareCliBundleMcpConfig resume hash", () => {
  it("stabilizes the resume hash when only the OpenClaw loopback port changes", async () => {
    const first = await prepareLoopbackConfig("http://127.0.0.1:23119/mcp");
    const second = await prepareLoopbackConfig("http://127.0.0.1:24567/mcp");

    expect(first.mcpConfigHash).not.toBe(second.mcpConfigHash);
    expect(first.mcpResumeHash).toBe(second.mcpResumeHash);

    await first.cleanup?.();
    await second.cleanup?.();
  });

  it("changes the resume hash when stable MCP semantics change", async () => {
    const first = await prepareLoopbackConfig("http://127.0.0.1:23119/mcp");
    const second = await prepareLoopbackConfig("http://127.0.0.1:23119/other");

    expect(first.mcpResumeHash).not.toBe(second.mcpResumeHash);

    await first.cleanup?.();
    await second.cleanup?.();
  });

  it("keeps OpenClaw approval state out of the resume identity", async () => {
    const prepare = async (options: Parameters<typeof buildSystemAgentToolsMcpServerConfig>[0]) =>
      await prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: { command: "node", args: ["./fake-claude.mjs"] },
        workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
        exclusiveConfig: buildSystemAgentToolsMcpServerConfig(options),
      });
    const proposed = "proposal-sha256";
    const first = await prepare({ surface: "cli", proposalRef: {} });
    const approval = await prepare({
      surface: "cli",
      approvalArmed: true,
      proposalRef: { current: proposed },
    });
    const otherSurface = await prepare({
      surface: "gateway",
      approvalArmed: true,
      proposalRef: { current: proposed },
    });

    expect(first.mcpConfigHash).not.toBe(approval.mcpConfigHash);
    expect(first.mcpResumeHash).toBe(approval.mcpResumeHash);
    expect(approval.mcpResumeHash).not.toBe(otherSurface.mcpResumeHash);
    const delegated = await prepare({
      surface: "cli",
      operatorApprovalOnly: true,
      approvalArmed: true,
      proposalRef: { current: proposed },
    });
    expect(delegated.mcpConfigHash).not.toBe(approval.mcpConfigHash);
    expect(delegated.mcpResumeHash).toBe(approval.mcpResumeHash);
    const binding = {
      sessionId: "native-cli-session",
      authProfileId: "claude-cli:ops",
      authEpoch: "auth-epoch",
      authEpochVersion: 1,
      cwdHash: "cwd-hash",
      mcpConfigHash: first.mcpConfigHash,
      mcpResumeHash: first.mcpResumeHash,
    };
    const reuseParams = {
      binding,
      authProfileId: binding.authProfileId,
      authEpoch: binding.authEpoch,
      authEpochVersion: binding.authEpochVersion,
      cwdHash: binding.cwdHash,
      mcpConfigHash: approval.mcpConfigHash,
      mcpResumeHash: approval.mcpResumeHash,
    };
    expect(resolveCliSessionReuse(reuseParams)).toEqual({
      mode: "reuse",
      sessionId: binding.sessionId,
    });
    expect(resolveCliSessionReuse({ ...reuseParams, authEpoch: "rotated-auth-epoch" })).toEqual({
      mode: "invalidate",
      invalidatedReason: "auth-epoch",
    });
    expect(resolveCliSessionReuse({ ...reuseParams, cwdHash: "other-cwd" })).toEqual({
      mode: "invalidate",
      invalidatedReason: "cwd",
    });

    await first.cleanup?.();
    await approval.cleanup?.();
    await otherSurface.cleanup?.();
    await delegated.cleanup?.();
  });
});
