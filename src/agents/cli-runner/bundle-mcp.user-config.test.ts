/** Tests merging user OpenClaw MCP server config into Claude bundle-MCP overlays. */
import fs from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeClaudeBundleManifest } from "../../plugins/bundle-mcp.test-support.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { peekSessionMcpRuntime, retireSessionMcpRuntime } from "../agent-bundle-mcp-manager-api.js";
import { startCompletionServer } from "../simple-completion.test-support.js";
import {
  type CliMcpParams,
  loopbackConfig,
  prepareMcp,
  readMcpConfig,
  userMcpConfig as userConfig,
} from "./bundle-mcp-fixtures.test-support.js";
import {
  cliBundleMcpHarness,
  cliNativeMcpPolicyContext,
  setupCliBundleMcpTestHarness,
  writeCliMcpPolicyProbeServer,
} from "./bundle-mcp.test-support.js";

const authMocks = vi.hoisted(() => ({
  recordMcpOAuthAuthorizationRequired: vi.fn(),
  resolveMcpOAuthAccessToken: vi.fn(),
}));

vi.mock("../mcp-oauth.js", () => ({
  recordMcpOAuthAuthorizationRequired: authMocks.recordMcpOAuthAuthorizationRequired,
  resolveMcpOAuthAccessToken: authMocks.resolveMcpOAuthAccessToken,
}));

setupCliBundleMcpTestHarness();

const catalogTools = (sessionId: string) =>
  peekSessionMcpRuntime({ sessionId })?.peekCatalog()?.tools;

async function prepareClaudeConfig(params: Partial<CliMcpParams>, close?: () => Promise<void>) {
  return prepareMcp({ mode: "claude-config-file", ...params }, async () => {
    if (params.nativeMcpPolicy) {
      await retireSessionMcpRuntime({
        sessionId: params.nativeMcpPolicy.sessionId,
        reason: "test-complete",
      });
    }
    await close?.();
  });
}

async function readServers(prepared: Awaited<ReturnType<typeof prepareClaudeConfig>>) {
  return (await readMcpConfig(prepared)).mcpServers;
}

async function startOAuthMcpProofServer() {
  const authorizationHeaders: Array<string | undefined> = [];
  const server = await startCompletionServer((request, response) => {
    void (async () => {
      const body = await text(request);
      authorizationHeaders.push(request.headers.authorization);
      if (request.headers.authorization !== "Bearer fresh-token") {
        response.writeHead(401, {
          "www-authenticate":
            'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"',
        });
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      const message = JSON.parse(body) as {
        id?: number;
        method?: string;
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "oauth-policy-proof", version: "1.0.0" },
            }
          : {
              tools: [
                { name: "read_docs", description: "Read docs", inputSchema: { type: "object" } },
              ],
            };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end();
      }
    });
  });
  return {
    authorizationHeaders,
    url: `${server.origin}/mcp`,
    close: () => server[Symbol.asyncDispose](),
  };
}

describe("prepareCliBundleMcpConfig user mcp.servers", () => {
  beforeEach(() => {
    authMocks.recordMcpOAuthAuthorizationRequired.mockReset();
    authMocks.resolveMcpOAuthAccessToken.mockReset();
  });

  it("translates OpenClaw transport field on user mcp.servers into Claude type", async () => {
    const prepared = await prepareClaudeConfig({
      config: userConfig({
        context7: {
          transport: "streamable-http",
          url: "https://mcp.context7.com/mcp",
          headers: { CONTEXT7_API_KEY: "ctx7sk-test" },
        },
        "omi-sse": {
          type: "http",
          transport: "sse",
          url: "https://api.omi.me/v1/mcp/sse",
        },
      }),
    });

    const servers = await readServers(prepared);
    expect(servers?.context7).toMatchObject({ type: "http", url: "https://mcp.context7.com/mcp" });
    expect(servers?.context7?.transport).toBeUndefined();
    expect(servers?.["omi-sse"]?.type).toBe("sse");
    expect(servers?.["omi-sse"]?.transport).toBeUndefined();
  });

  it("omits unavailable OAuth servers without blocking the CLI agent", async () => {
    authMocks.resolveMcpOAuthAccessToken.mockRejectedValueOnce(
      new Error('MCP server "gbrain" requires OAuth authorization.'),
    );
    const warn = vi.fn();
    const serverPath = await writeCliMcpPolicyProbeServer();
    const sessionId = "claude-unavailable-oauth-policy";
    const config = userConfig(
      {
        gbrain: {
          transport: "streamable-http",
          url: "https://gbrain.example.com/mcp",
          auth: "oauth",
        },
        localTools: {
          transport: "stdio",
          command: process.execPath,
          args: [serverPath],
        },
      },
      { tools: { allow: ["localTools__read_docs"] } },
    );

    const prepared = await prepareClaudeConfig({
      config,
      nativeMcpPolicy: cliNativeMcpPolicyContext(config, sessionId),
      warn,
    });

    expect(Object.keys((await readServers(prepared)) ?? {})).toEqual(["localTools"]);
    expect([...new Set(catalogTools(sessionId)?.map((tool) => tool.serverName))]).toEqual([
      "localTools",
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipped unavailable OAuth server gbrain"),
    );
  });

  it("keeps native OAuth refresh available while projecting the child bearer", async () => {
    const proof = await startOAuthMcpProofServer();
    const sessionId = "claude-native-policy-oauth-refresh";
    authMocks.resolveMcpOAuthAccessToken
      .mockResolvedValue("fresh-token")
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("stale-token");
    const config = userConfig(
      {
        docs: {
          transport: "streamable-http",
          url: proof.url,
          auth: "oauth",
          oauth: { scope: "docs.read" },
        },
      },
      { tools: { allow: ["docs__read_docs"] } },
    );

    const prepared = await prepareClaudeConfig(
      {
        workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
        config,
        nativeMcpPolicy: cliNativeMcpPolicyContext(config, sessionId),
      },
      proof.close,
    );

    const servers = await readServers(prepared);
    expect(proof.authorizationHeaders.slice(0, 2)).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
    expect(catalogTools(sessionId)?.map((tool) => tool.toolName)).toEqual(["read_docs"]);
    expect(servers?.docs).toMatchObject({
      headers: { Authorization: "Bearer fresh-token" },
    });
    expect([servers?.docs?.auth, servers?.docs?.oauth]).toEqual([undefined, undefined]);
    expect(proof.authorizationHeaders.some((value) => value?.includes("OPENCLAW_MCP_AUTH"))).toBe(
      false,
    );
  });

  it("user mcp.servers do not override the loopback additionalConfig", async () => {
    const prepared = await prepareClaudeConfig({
      config: userConfig({ openclaw: { type: "http", url: "https://example.com/malicious" } }),
      additionalConfig: loopbackConfig({
        headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
      }),
    });

    expect((await readServers(prepared))?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
  });

  it("replaces overlapping bundle server entries with user-configured mcp.servers", async () => {
    await writeClaudeBundleManifest({
      homeDir: cliBundleMcpHarness.bundleProbeHomeDir,
      pluginId: "omi",
      manifest: { name: "omi" },
    });
    const pluginDir = path.join(cliBundleMcpHarness.bundleProbeHomeDir, ".openclaw/extensions/omi");
    await fs.writeFile(
      path.join(pluginDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          omi: {
            command: process.execPath,
            args: [cliBundleMcpHarness.bundleProbeServerPath],
            env: { BUNDLE_ONLY: "true" },
          },
        },
      }),
    );
    await withEnvAsync({ HOME: cliBundleMcpHarness.bundleProbeHomeDir }, async () => {
      const prepared = await prepareClaudeConfig({
        config: userConfig(
          {
            omi: {
              type: "sse",
              url: "https://api.omi.me/v1/mcp/sse",
              headers: { Authorization: "Bearer test-token" },
            },
          },
          { plugins: { entries: { omi: { enabled: true } } } },
        ),
      });

      const servers = await readServers(prepared);
      expect(servers?.omi).toMatchObject({ type: "sse", url: "https://api.omi.me/v1/mcp/sse" });
      expect(servers?.omi?.command).toBeUndefined();
      expect(servers?.omi?.args).toBeUndefined();
      expect(servers?.omi?.env).toBeUndefined();
    });
  });
});
