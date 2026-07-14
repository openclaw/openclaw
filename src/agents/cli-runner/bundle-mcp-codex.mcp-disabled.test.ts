/** Tests MCP disabled-field migration in Codex user MCP server projection. */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCodexUserMcpServersThreadConfigPatch } from "./bundle-mcp-codex.js";

const authMocks = vi.hoisted(() => ({
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveMcpOAuthAccessToken: vi.fn(),
}));

vi.mock("../auth-profiles/store.js", () => ({
  loadAuthProfileStoreForSecretsRuntime: authMocks.loadAuthProfileStoreForSecretsRuntime,
}));

vi.mock("../auth-profiles/oauth.js", () => ({
  resolveApiKeyForProfile: authMocks.resolveApiKeyForProfile,
}));

vi.mock("../mcp-oauth.js", () => ({
  resolveMcpOAuthAccessToken: authMocks.resolveMcpOAuthAccessToken,
}));

describe("buildCodexUserMcpServersThreadConfigPatch MCP disabled migration", () => {
  it("migrates legacy disabled: true when projecting Codex user MCP servers", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          legacyDisabled: {
            disabled: true,
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
});
