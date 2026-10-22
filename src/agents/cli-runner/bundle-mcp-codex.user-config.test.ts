/** Tests projecting OpenClaw user MCP servers into Codex app-server config. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../config/types.mcp.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCodexUserMcpServersThreadConfigPatchForRuntime } from "./bundle-mcp-codex.js";

const project = (
  servers: Record<string, McpServerConfig>,
  options?: Parameters<typeof buildCodexUserMcpServersThreadConfigPatchForRuntime>[1],
) => buildCodexUserMcpServersThreadConfigPatchForRuntime({ mcp: { servers } }, options);
const http = (url: string, options: Partial<McpServerConfig> = {}): McpServerConfig => ({
  transport: "streamable-http",
  url,
  ...options,
});
function expectProjection(
  patch: Awaited<ReturnType<typeof project>>,
  mcp_servers: NonNullable<Awaited<ReturnType<typeof project>>>["mcp_servers"],
) {
  expect(patch).toStrictEqual({ mcp_servers });
}

const authMocks = vi.hoisted(() => ({
  loadExecApprovalsReadOnlyAsync: vi.fn(),
  loadAuthProfileStoreForRuntimeAsync: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveMcpOAuthAccessToken: vi.fn(),
}));

vi.mock("../../infra/exec-approvals-store.js", () => ({
  loadExecApprovalsReadOnlyAsync: authMocks.loadExecApprovalsReadOnlyAsync,
}));

// mock-isolation: MCP projection consumes synthetic profile snapshots without reading host stores.
vi.mock("../auth-profiles/store-runtime.js", () => ({
  loadAuthProfileStoreForRuntimeAsync: authMocks.loadAuthProfileStoreForRuntimeAsync,
}));

vi.mock("../auth-profiles/oauth.js", () => ({
  resolveApiKeyForProfile: authMocks.resolveApiKeyForProfile,
}));

vi.mock("../mcp-oauth.js", () => ({
  resolveMcpOAuthAccessToken: authMocks.resolveMcpOAuthAccessToken,
}));

describe("buildCodexUserMcpServersThreadConfigPatchForRuntime", () => {
  beforeEach(() => {
    for (const mock of Object.values(authMocks)) {
      mock.mockReset();
    }
    authMocks.loadExecApprovalsReadOnlyAsync.mockResolvedValue({ version: 1, agents: {} });
  });

  it("projects exact-agent durable grants with server policy precedence in runtime preparation", async () => {
    const grants = ["auto", "unspecified", "prompt", "approve", "missing"].map((server) => ({
      server,
      tool: "write.raw_tool",
      source: "allow-always",
      addedAt: 1,
    }));
    authMocks.loadExecApprovalsReadOnlyAsync.mockResolvedValue({
      version: 1,
      agents: {
        main: { mcpTools: grants },
        other: { mcpTools: [{ ...grants[0], tool: "other_tool" }] },
        "*": { mcpTools: [{ ...grants[0], tool: "wildcard_tool" }] },
      },
    });
    const servers = {
      auto: { command: "mcp", codex: { defaultToolsApprovalMode: "auto" } },
      unspecified: { command: "mcp", toolFilter: { exclude: ["write.raw_tool"] } },
      prompt: { command: "mcp", codex: { defaultToolsApprovalMode: "prompt" } },
      approve: { command: "mcp", codex: { defaultToolsApprovalMode: "approve" } },
    } satisfies Record<string, McpServerConfig>;
    const patch = await project(servers, { agentId: "main" });

    expect(patch?.mcp_servers).toEqual({
      auto: {
        command: "mcp",
        default_tools_approval_mode: "auto",
        tools: { "write.raw_tool": { approval_mode: "approve" } },
      },
      unspecified: {
        command: "mcp",
        disabled_tools: ["write.raw_tool"],
        tools: { "write.raw_tool": { approval_mode: "approve" } },
      },
      prompt: { command: "mcp", default_tools_approval_mode: "prompt" },
      approve: { command: "mcp", default_tools_approval_mode: "approve" },
    });
    expect(authMocks.loadExecApprovalsReadOnlyAsync).toHaveBeenCalledTimes(1);
    expect((await project(servers))?.mcp_servers.auto).not.toHaveProperty("tools");
  });

  it("projects session server and tool overrides into user MCP config", async () => {
    const patch = await project(
      {
        disabledDocs: { enabled: false, url: "https://disabled-docs.example.com/mcp" },
        constructor: { url: "https://constructor.example.com/mcp" },
        search: { url: "https://search.example.com/mcp" },
      },
      {
        toolOverrides: {
          mcpServers: { disabledDocs: true, search: false },
          mcpToolsDeny: { disabledDocs: ["delete_page"] },
        },
      },
    );

    expect(patch).toEqual({
      mcp_servers: {
        constructor: {
          url: "https://constructor.example.com/mcp",
        },
        disabledDocs: {
          url: "https://disabled-docs.example.com/mcp",
          disabled_tools: ["delete_page"],
        },
      },
    });
  });

  it("projects a stdio user MCP server entry into mcp_servers (regression: #80814)", async () => {
    const patch = await project({
      outlook: {
        transport: "stdio",
        command: "node",
        args: ["/opt/outlook-mcp/dist/index.js"],
        env: { OUTLOOK_USER: "alice@example.org" },
      },
    });
    expectProjection(patch, {
      outlook: {
        command: "node",
        args: ["/opt/outlook-mcp/dist/index.js"],
        env: { OUTLOOK_USER: "alice@example.org" },
      },
    });
  });

  it("projects a streamable-http user MCP server with bearer auth into mcp_servers", async () => {
    const patch = await project({
      notes: http("https://notes.example.org/mcp", {
        headers: { Authorization: "Bearer ${NOTES_TOKEN}", "x-tenant": "${NOTES_TENANT}" },
      }),
    });
    expectProjection(patch, {
      notes: {
        url: "https://notes.example.org/mcp",
        bearer_token_env_var: "NOTES_TOKEN",
        env_http_headers: { "x-tenant": "NOTES_TENANT" },
      },
    });
  });

  it("rejects wildcard OpenClaw MCP tool filters that Codex cannot project exactly", async () => {
    await expect(
      project({
        docs: http("https://docs.example.com/mcp", { toolFilter: { include: ["search_*"] } }),
      }),
    ).rejects.toThrow(
      'Cannot project mcp.servers.docs.toolFilter.include pattern "search_*" into Codex enabled_tools',
    );
  });

  it("filters Codex-scoped user MCP servers by OpenClaw agent id", async () => {
    const servers = {
      atlas: http("https://atlas.example.com/mcp", { codex: { agents: ["atlas"] } }),
      apolo: http("https://apolo.example.com/mcp", { codex: { agents: ["apolo"] } }),
      global: { transport: "stdio", command: "node", args: ["global-mcp.js"] },
    } satisfies Record<string, McpServerConfig>;
    for (const agentId of ["atlas", "apolo"]) {
      expectProjection(await project(servers, { agentId }), {
        [agentId]: { url: `https://${agentId}.example.com/mcp` },
        global: { command: "node", args: ["global-mcp.js"] },
      });
    }
  });

  it("omits disabled user MCP servers from Codex app-server projection", async () => {
    const patch = await buildCodexUserMcpServersThreadConfigPatchForRuntime({
      mcp: {
        servers: {
          disabled: {
            enabled: false,
            transport: "streamable-http",
            url: "https://disabled.example.com/mcp",
          },
          enabled: {
            transport: "stdio",
            command: "node",
            args: ["enabled-mcp.js"],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(patch).toStrictEqual({
      mcp_servers: {
        enabled: {
          command: "node",
          args: ["enabled-mcp.js"],
        },
      },
    });
  });

  it("fails closed for empty or invalid Codex agent scopes", async () => {
    const patch = await project(
      {
        empty: http("https://empty.example.com/mcp", { codex: { agents: [] } }),
        blank: http("https://blank.example.com/mcp", { codex: { agents: ["  "] } }),
        invalid: {
          transport: "streamable-http",
          url: "https://invalid.example.com/mcp",
          codex: { agents: ["", 1, null, "!!!", "-main-"] },
        } as unknown as McpServerConfig,
        global: { transport: "stdio", command: "node", args: ["global-mcp.js"] },
      },
      { agentId: "atlas" },
    );
    expectProjection(patch, { global: { command: "node", args: ["global-mcp.js"] } });
  });

  it("omits scoped Codex MCP servers when no OpenClaw agent id is available", async () => {
    const patch = await project({
      atlas: http("https://atlas.example.com/mcp", { codex: { agents: ["atlas"] } }),
    });
    expect(patch).toBeUndefined();
  });

  it("projects MCP-native OAuth credentials into local Codex runtime config", async () => {
    authMocks.resolveMcpOAuthAccessToken.mockResolvedValueOnce("native-access-token");

    const patch = await project({
      docs: http("https://mcp.example.com/mcp", {
        auth: "oauth",
        oauth: { scope: "docs.read" },
      }),
    });

    expectProjection(patch, {
      docs: {
        url: "https://mcp.example.com/mcp",
        http_headers: { Authorization: "Bearer native-access-token" },
      },
    });
  });

  it("omits MCP-native OAuth servers that still need authorization", async () => {
    authMocks.resolveMcpOAuthAccessToken.mockRejectedValueOnce(
      new Error('MCP server "gbrain" requires OAuth authorization.'),
    );
    const onServerUnavailable = vi.fn();

    const patch = await project(
      {
        gbrain: http("https://gbrain.example.com/mcp", { auth: "oauth" }),
        localTools: { transport: "stdio", command: "local-tools" },
      },
      { onServerUnavailable },
    );

    expectProjection(patch, { localTools: { command: "local-tools" } });
    expect(onServerUnavailable).toHaveBeenCalledWith("gbrain", expect.any(Error));
  });

  it("omits MCP-native OAuth projection from a remote Codex app-server", async () => {
    const onServerUnavailable = vi.fn();
    await expect(
      project(
        { docs: http("https://mcp.example.com/mcp", { auth: "oauth" }) },
        { allowLiteralOAuthProjection: false, onServerUnavailable },
      ),
    ).resolves.toBeUndefined();
    expect(onServerUnavailable).toHaveBeenCalledWith("docs", expect.any(Error));
    expect(authMocks.resolveMcpOAuthAccessToken).not.toHaveBeenCalled();
  });

  it("preserves tool filters while projecting auth-profile backed MCP bearers at runtime", async () => {
    const credential = {
      type: "oauth",
      provider: "ducktape",
      access: "expired-access",
      refresh: "refresh-token-must-not-project",
      expires: 1,
    };
    authMocks.loadAuthProfileStoreForRuntimeAsync.mockResolvedValueOnce({
      version: 1,
      profiles: { "ducktape:mcp": credential },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValueOnce({
      apiKey: "fresh-access-token",
      provider: "ducktape",
      profileId: "ducktape:mcp",
      profileType: "oauth",
      credential: {
        ...credential,
        access: "fresh-access-token",
        expires: Date.now() + 60_000,
      },
    });

    const patch = await project({
      ducktape: http("https://agents.ducktape.xyz/mcp", {
        auth: "oauth",
        oauth: { authProfileId: "ducktape:mcp" },
        headers: { Authorization: "Bearer stale-access", "x-tenant": "keep" },
        toolFilter: { include: ["proof_echo", "proof_search"], exclude: ["admin_delete"] },
      }),
    });

    expectProjection(patch, {
      ducktape: {
        url: "https://agents.ducktape.xyz/mcp",
        http_headers: { Authorization: "Bearer fresh-access-token", "x-tenant": "keep" },
        enabled_tools: ["proof_echo", "proof_search"],
        disabled_tools: ["admin_delete"],
      },
    });
    expect(JSON.stringify(patch)).not.toContain("refresh-token-must-not-project");
  });
});
