import { describe, expect, it } from "vitest";
import { buildSystemAgentToolsMcpServerConfig } from "../../mcp/openclaw-tools-serve-config.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { retireSessionMcpRuntime } from "../agent-bundle-mcp-manager-api.js";
import { resolveCliSessionReuse } from "../cli-session.js";
import {
  loopbackConfig,
  policyConfig,
  prepareMcp as prepareCliBundleMcpConfig,
  trackMcpPreparation,
  userMcpConfig,
} from "./bundle-mcp-fixtures.test-support.js";
import {
  cliBundleMcpHarness,
  cliNativeMcpPolicyContext,
  prepareBundleProbeCliConfig,
  prepareNativeMcpTestConfig,
  setupCliBundleMcpTestHarness,
} from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

describe("prepareCliBundleMcpConfig codex", () => {
  it.each([
    ["agent:worker:policy", undefined],
    ["global", "worker"],
  ] as const)(
    "keeps Codex server ownership separate from the runtime policy owner (%s)",
    async (sandboxSessionKey, sandboxAgentId) => {
      const workspaceDir = cliBundleMcpHarness.bundleProbeWorkspaceDir;
      const sessionId = "codex-independent-policy-owner";
      const config = await policyConfig({
        agents: { entries: { main: {}, worker: { tools: { deny: ["docs__delete_docs"] } } } },
        server: { codex: { agents: ["main"] } },
      });
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: cliBundleMcpHarness.bundleProbeHomeDir },
        async () => {
          try {
            const patch = await prepareNativeMcpTestConfig({
              sessionId,
              sessionKey: "agent:main:conversation",
              sandboxSessionKey,
              sandboxAgentId,
              timeoutMs: 1_000,
              workspaceDir,
              config,
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
      workspaceDir: "/tmp/openclaw-cli-codex-web-search-disabled",
      toolOverrides: { webSearch: false },
    });

    expect(prepared.backend.args).toEqual(["exec", "-c", 'web_search="disabled"']);
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("projects session MCP tool denials into Codex disabled_tools", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      mode: "codex-config-overrides",
      workspaceDir: "/tmp/openclaw-bundle-mcp-codex-deny",
      config: userMcpConfig({
        docs: { transport: "streamable-http", url: "https://docs.example.com/mcp" },
      }),
      toolOverrides: { mcpToolsDeny: { docs: ["delete_docs"] }, webSearch: false },
    });

    expect(prepared.backend.args?.find((arg) => arg.startsWith("mcp_servers="))).toContain(
      'disabled_tools = ["delete_docs"]',
    );
    expect(prepared.backend.args).toContain('web_search="disabled"');
  });

  it("projects configured wildcard filters as exact Codex CLI overrides", async () => {
    const config = await policyConfig({
      tools: { allow: ["docs__*"] },
      server: { toolFilter: { exclude: ["delete_*"] } },
    });
    const prepared = await prepareCliBundleMcpConfig({
      mode: "codex-config-overrides",
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
      mode: "codex-config-overrides",
      backend: {
        command: "codex",
        args: ["exec", "--json"],
        resumeArgs: ["exec", "resume", "{sessionId}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-codex",
      config: { plugins: { enabled: false } },
      additionalConfig: loopbackConfig({
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          "x-openclaw-cli-capture-key": "${OPENCLAW_MCP_CLI_CAPTURE_KEY}",
        },
      }),
    });

    const override =
      'mcp_servers={ openclaw = { url = "http://127.0.0.1:23119/mcp", default_tools_approval_mode = "approve", bearer_token_env_var = "OPENCLAW_MCP_TOKEN", env_http_headers = { x-session-key = "OPENCLAW_MCP_SESSION_KEY", x-openclaw-cli-capture-key = "OPENCLAW_MCP_CLI_CAPTURE_KEY" } } }';
    expect(prepared.backend.args).toEqual(["exec", "--json", "-c", override]);
    expect(prepared.backend.resumeArgs).toEqual(["exec", "resume", "{sessionId}", "-c", override]);
    expect(prepared.cleanup).toBeUndefined();
  });
});

const prepareLoopbackConfig = (url: string) =>
  trackMcpPreparation(
    prepareBundleProbeCliConfig({
      additionalConfig: loopbackConfig({
        url,
        headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
      }),
    }),
  );

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
  });

  it("keeps OpenClaw approval state out of the resume identity", async () => {
    const prepare = async (options: Parameters<typeof buildSystemAgentToolsMcpServerConfig>[0]) =>
      await prepareCliBundleMcpConfig({
        mode: "claude-config-file",
        exclusiveConfig: buildSystemAgentToolsMcpServerConfig(options),
      });
    const armed = { approvalArmed: true, proposalRef: { current: "proposal-sha256" } };
    const first = await prepare({ surface: "cli", proposalRef: {} });
    const approval = await prepare({ surface: "cli", ...armed });
    const otherSurface = await prepare({ surface: "gateway", ...armed });

    expect(first.mcpConfigHash).not.toBe(approval.mcpConfigHash);
    expect(first.mcpResumeHash).toBe(approval.mcpResumeHash);
    expect(approval.mcpResumeHash).not.toBe(otherSurface.mcpResumeHash);
    const delegated = await prepare({ surface: "cli", operatorApprovalOnly: true, ...armed });
    expect(delegated.mcpConfigHash).not.toBe(approval.mcpConfigHash);
    expect(delegated.mcpResumeHash).toBe(approval.mcpResumeHash);
    expect(
      resolveCliSessionReuse({
        binding: {
          sessionId: "native-cli-session",
          authEpochVersion: 1,
          mcpConfigHash: first.mcpConfigHash,
          mcpResumeHash: first.mcpResumeHash,
        },
        authEpochVersion: 1,
        mcpConfigHash: approval.mcpConfigHash,
        mcpResumeHash: approval.mcpResumeHash,
      }),
    ).toEqual({ mode: "reuse", sessionId: "native-cli-session" });
  });
});
