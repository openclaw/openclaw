/** Tests projecting OpenClaw user MCP servers into Codex app-server config. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildCodexUserMcpServersThreadConfigPatch,
  resolveCodexMcpServerAllow,
} from "./bundle-mcp-codex.js";

describe("buildCodexUserMcpServersThreadConfigPatch", () => {
  it("returns undefined when cfg has no mcp.servers (regression: #80814)", () => {
    expect(buildCodexUserMcpServersThreadConfigPatch(undefined)).toBeUndefined();
    expect(buildCodexUserMcpServersThreadConfigPatch({} as OpenClawConfig)).toBeUndefined();
    expect(
      buildCodexUserMcpServersThreadConfigPatch({ mcp: {} } as OpenClawConfig),
    ).toBeUndefined();
    expect(
      buildCodexUserMcpServersThreadConfigPatch({ mcp: { servers: {} } } as OpenClawConfig),
    ).toBeUndefined();
  });

  it("projects a stdio user MCP server entry into mcp_servers (regression: #80814)", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          outlook: {
            transport: "stdio",
            command: "node",
            args: ["/opt/outlook-mcp/dist/index.js"],
            env: { OUTLOOK_USER: "alice@example.org" },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toStrictEqual({
      mcp_servers: {
        outlook: {
          command: "node",
          args: ["/opt/outlook-mcp/dist/index.js"],
          env: { OUTLOOK_USER: "alice@example.org" },
        },
      },
    });
  });

  it("projects a streamable-http user MCP server with bearer auth into mcp_servers", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          notes: {
            transport: "streamable-http",
            url: "https://notes.example.org/mcp",
            headers: {
              Authorization: "Bearer ${NOTES_TOKEN}",
              "x-tenant": "${NOTES_TENANT}",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toStrictEqual({
      mcp_servers: {
        notes: {
          url: "https://notes.example.org/mcp",
          bearer_token_env_var: "NOTES_TOKEN",
          env_http_headers: { "x-tenant": "NOTES_TENANT" },
        },
      },
    });
  });

  it("projects Codex-specific default tool approval mode", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          search: {
            transport: "streamable-http",
            url: "https://mcp.example.com/mcp",
            codex: {
              defaultToolsApprovalMode: "approve",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toStrictEqual({
      mcp_servers: {
        search: {
          url: "https://mcp.example.com/mcp",
          default_tools_approval_mode: "approve",
        },
      },
    });
  });

  it("uses the Codex-native approval spelling when configured", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          search: {
            transport: "streamable-http",
            url: "https://mcp.example.com/mcp",
            codex: {
              default_tools_approval_mode: "prompt",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch?.mcp_servers.search).toMatchObject({
      url: "https://mcp.example.com/mcp",
      default_tools_approval_mode: "prompt",
    });
  });

  it("filters Codex-scoped user MCP servers by OpenClaw agent id", () => {
    // Agent-scoped MCP servers should follow the active OpenClaw agent, while
    // unscoped servers remain global.
    const cfg = {
      mcp: {
        servers: {
          atlas: {
            transport: "streamable-http",
            url: "https://atlas.example.com/mcp",
            codex: { agents: ["atlas"] },
          },
          apolo: {
            transport: "streamable-http",
            url: "https://apolo.example.com/mcp",
            codex: { agents: ["apolo"] },
          },
          global: {
            transport: "stdio",
            command: "node",
            args: ["global-mcp.js"],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const atlasPatch = buildCodexUserMcpServersThreadConfigPatch(cfg, { agentId: "atlas" });
    expect(Object.keys(atlasPatch!.mcp_servers).toSorted()).toEqual(["atlas", "global"]);
    expect(atlasPatch!.mcp_servers.atlas).toMatchObject({ url: "https://atlas.example.com/mcp" });
    expect(atlasPatch!.mcp_servers.global).toMatchObject({
      command: "node",
      args: ["global-mcp.js"],
    });

    const apoloPatch = buildCodexUserMcpServersThreadConfigPatch(cfg, { agentId: "apolo" });
    expect(Object.keys(apoloPatch!.mcp_servers).toSorted()).toEqual(["apolo", "global"]);
    expect(apoloPatch!.mcp_servers.apolo).toMatchObject({ url: "https://apolo.example.com/mcp" });
  });

  it("returns undefined when all user MCP servers are scoped to other agents", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch(
      {
        mcp: {
          servers: {
            atlas: {
              transport: "streamable-http",
              url: "https://atlas.example.com/mcp",
              codex: { agents: ["atlas"] },
            },
          },
        },
      } as unknown as OpenClawConfig,
      { agentId: "apolo" },
    );
    expect(patch).toBeUndefined();
  });

  it("omits disabled user MCP servers from Codex app-server projection", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
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

  it("normalizes Codex agent scopes before matching", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch(
      {
        mcp: {
          servers: {
            atlas: {
              transport: "streamable-http",
              url: "https://atlas.example.com/mcp",
              codex: { agents: ["Atlas"] },
            },
          },
        },
      } as unknown as OpenClawConfig,
      { agentId: "ATLAS" },
    );
    expect(patch?.mcp_servers.atlas).toMatchObject({
      url: "https://atlas.example.com/mcp",
    });
  });

  it("fails closed for empty or invalid Codex agent scopes", () => {
    const cfg = {
      mcp: {
        servers: {
          empty: {
            transport: "streamable-http",
            url: "https://empty.example.com/mcp",
            codex: { agents: [] },
          },
          blank: {
            transport: "streamable-http",
            url: "https://blank.example.com/mcp",
            codex: { agents: ["  "] },
          },
          invalid: {
            transport: "streamable-http",
            url: "https://invalid.example.com/mcp",
            codex: { agents: ["", 1, null, "!!!", "-main-"] },
          },
          global: {
            transport: "stdio",
            command: "node",
            args: ["global-mcp.js"],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const patch = buildCodexUserMcpServersThreadConfigPatch(cfg, { agentId: "atlas" });
    expect(patch).toStrictEqual({
      mcp_servers: {
        global: {
          command: "node",
          args: ["global-mcp.js"],
        },
      },
    });
  });

  it("omits scoped Codex MCP servers when no OpenClaw agent id is available", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          atlas: {
            transport: "streamable-http",
            url: "https://atlas.example.com/mcp",
            codex: { agents: ["atlas"] },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch).toBeUndefined();
  });

  it("preserves multiple user MCP servers as independent mcp_servers entries", () => {
    const patch = buildCodexUserMcpServersThreadConfigPatch({
      mcp: {
        servers: {
          one: { transport: "stdio", command: "one" },
          two: { transport: "stdio", command: "two" },
        },
      },
    } as unknown as OpenClawConfig);
    expect(patch?.mcp_servers).toBeDefined();
    expect(Object.keys(patch!.mcp_servers).toSorted()).toEqual(["one", "two"]);
    expect(patch!.mcp_servers.one).toMatchObject({ command: "one" });
    expect(patch!.mcp_servers.two).toMatchObject({ command: "two" });
  });

  describe("allowlist-aware server projection", () => {
    const twoServerCfg = {
      mcp: {
        servers: {
          opik: { transport: "stdio", command: "opik" },
          notion: { transport: "stdio", command: "notion" },
        },
      },
    } as unknown as OpenClawConfig;

    it("attaches every enabled server when toolsAllow is undefined (no restriction)", () => {
      const patch = buildCodexUserMcpServersThreadConfigPatch(twoServerCfg, {
        toolsAllow: undefined,
      });
      expect(Object.keys(patch!.mcp_servers).toSorted()).toEqual(["notion", "opik"]);
    });

    it("attaches every server for a wildcard allowlist", () => {
      const patch = buildCodexUserMcpServersThreadConfigPatch(twoServerCfg, {
        toolsAllow: ["*"],
      });
      expect(Object.keys(patch!.mcp_servers).toSorted()).toEqual(["notion", "opik"]);
    });

    it("attaches only the server referenced by a server-scoped glob", () => {
      const patch = buildCodexUserMcpServersThreadConfigPatch(twoServerCfg, {
        toolsAllow: ["opik__*"],
      });
      expect(Object.keys(patch!.mcp_servers)).toEqual(["opik"]);
      // A server glob grants every tool, so no enabled_tools filter is emitted.
      expect(patch!.mcp_servers.opik).not.toHaveProperty("enabled_tools");
    });

    it("scopes an attached server to exact tools via enabled_tools", () => {
      const patch = buildCodexUserMcpServersThreadConfigPatch(twoServerCfg, {
        toolsAllow: ["opik__list", "opik__read", "notion__api-post-search"],
      });
      expect(Object.keys(patch!.mcp_servers).toSorted()).toEqual(["notion", "opik"]);
      expect(patch!.mcp_servers.opik).toMatchObject({ enabled_tools: ["list", "read"] });
      expect(patch!.mcp_servers.notion).toMatchObject({ enabled_tools: ["api-post-search"] });
    });

    it("does not set enabled_tools for a wildcard allowlist", () => {
      const patch = buildCodexUserMcpServersThreadConfigPatch(twoServerCfg, { toolsAllow: ["*"] });
      expect(patch!.mcp_servers.opik).not.toHaveProperty("enabled_tools");
      expect(patch!.mcp_servers.notion).not.toHaveProperty("enabled_tools");
    });

    it("matches the provider-safe (sanitized) server name, not the raw config key", () => {
      const cfg = {
        mcp: {
          servers: {
            "Outlook Graph": { transport: "stdio", command: "outlook" },
          },
        },
      } as unknown as OpenClawConfig;
      // The model-facing prefix is `outlook-graph__`, so that is what the operator
      // writes in the allowlist — the raw "Outlook Graph" key must still resolve.
      const patch = buildCodexUserMcpServersThreadConfigPatch(cfg, {
        toolsAllow: ["outlook-graph__*"],
      });
      expect(Object.keys(patch!.mcp_servers)).toEqual(["Outlook Graph"]);
    });

    it("does not let a disabled server's name collision shift an enabled server's prefix", () => {
      // "atlas" (disabled) and "Atlas" (enabled) both reserve the lowercase name
      // "atlas". If the disabled one reserves first, the enabled one is pushed to
      // "Atlas-2" and the operator's `atlas__*` allowlist no longer matches it. The
      // disabled server must be skipped before any name is reserved.
      const cfg = {
        mcp: {
          servers: {
            atlas: { enabled: false, transport: "stdio", command: "old" },
            Atlas: { transport: "stdio", command: "new" },
          },
        },
      } as unknown as OpenClawConfig;
      const patch = buildCodexUserMcpServersThreadConfigPatch(cfg, { toolsAllow: ["atlas__*"] });
      expect(Object.keys(patch!.mcp_servers)).toEqual(["Atlas"]);
    });

    it("honors bundle-mcp and group:plugins as attach-all entries", () => {
      for (const token of ["bundle-mcp", "group:plugins"]) {
        const patch = buildCodexUserMcpServersThreadConfigPatch(twoServerCfg, {
          toolsAllow: [token],
        });
        expect(Object.keys(patch!.mcp_servers).toSorted()).toEqual(["notion", "opik"]);
      }
    });

    it("returns undefined when the allowlist references no configured server", () => {
      expect(
        buildCodexUserMcpServersThreadConfigPatch(twoServerCfg, { toolsAllow: ["message"] }),
      ).toBeUndefined();
      expect(
        buildCodexUserMcpServersThreadConfigPatch(twoServerCfg, { toolsAllow: [] }),
      ).toBeUndefined();
    });
  });

  describe("resolveCodexMcpServerAllow", () => {
    it("includes all tools when the allowlist is undefined", () => {
      expect(resolveCodexMcpServerAllow("opik", undefined)).toEqual({ include: true });
    });

    it("includes all tools for wildcard, bundle-mcp, group:plugins, or a server glob", () => {
      expect(resolveCodexMcpServerAllow("opik", ["*"])).toEqual({ include: true });
      expect(resolveCodexMcpServerAllow("opik", ["bundle-mcp"])).toEqual({ include: true });
      expect(resolveCodexMcpServerAllow("opik", ["group:plugins"])).toEqual({ include: true });
      expect(resolveCodexMcpServerAllow("opik", ["opik__*"])).toEqual({ include: true });
      expect(resolveCodexMcpServerAllow("opik", [" Opik__* "])).toEqual({ include: true }); // trims/lowercases
    });

    it("scopes to named tools for exact tool tokens", () => {
      expect(resolveCodexMcpServerAllow("opik", ["opik__list", "opik__read"])).toEqual({
        include: true,
        toolNames: ["list", "read"],
      });
    });

    it("excludes a server with no matching token", () => {
      expect(resolveCodexMcpServerAllow("opik", ["notion__*"])).toEqual({ include: false });
      expect(resolveCodexMcpServerAllow("opik", ["message"])).toEqual({ include: false });
      expect(resolveCodexMcpServerAllow("opik", ["opik__"])).toEqual({ include: false }); // bare prefix, no tool
      expect(resolveCodexMcpServerAllow("opik", [])).toEqual({ include: false });
    });
  });
});
