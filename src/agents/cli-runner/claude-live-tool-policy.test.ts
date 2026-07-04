import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isClaudeMcpProxyToolAllowed,
  resolveClaudeLiveMcpToolPolicy,
} from "./claude-live-tool-policy.js";
import type { PreparedCliRunContext } from "./types.js";

function buildContext(params: {
  config?: OpenClawConfig;
  agentId?: string;
  senderUsername?: string;
  sandboxSessionKey?: string;
  modelProvider?: string;
  policies?: PreparedCliRunContext["preparedBackend"]["mcpServerToolPolicies"] | null;
  nativeServerNames?: string[];
}): PreparedCliRunContext {
  const mcpServerToolPolicies =
    params.policies === null
      ? undefined
      : (params.policies ?? {
          openclaw: { configuredName: "openclaw", safeName: "openclaw" },
          "openclaw-mcp-computer-use": {
            configuredName: "computer-use",
            safeName: "computer-use",
          },
        });
  return {
    params: {
      sessionId: "session-1",
      sessionKey: "agent:test:direct:user",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: params.config,
      prompt: "test",
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      timeoutMs: 1_000,
      runId: "run-1",
      agentId: params.agentId ?? "test",
      senderUsername: params.senderUsername,
      sandboxSessionKey: params.sandboxSessionKey,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "claude-cli",
      modelProvider: params.modelProvider,
      config: {
        command: "claude",
        args: ["-p"],
        output: "jsonl",
        input: "stdin",
      },
      bundleMcp: true,
    },
    preparedBackend: {
      backend: {
        command: "claude",
        args: ["-p"],
        output: "jsonl",
        input: "stdin",
      },
      ...(mcpServerToolPolicies ? { mcpServerToolPolicies } : {}),
      mcpNativeServerNames: params.nativeServerNames,
    },
    reusableCliSession: {},
    hadSessionFile: false,
    contextEngineConfig: params.config ?? {},
    modelId: "claude-sonnet-4-6",
    normalizedModel: "claude-sonnet-4-6",
    systemPrompt: "test",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

function expectProxyToolAllowed(
  policy: ReturnType<typeof resolveClaudeLiveMcpToolPolicy>,
  toolName: string,
  allowed: boolean,
): void {
  const proxy = policy.proxyServers[0];
  expect(proxy).toBeDefined();
  expect(isClaudeMcpProxyToolAllowed(proxy, toolName)).toBe(allowed);
}

describe("resolveClaudeLiveMcpToolPolicy", () => {
  it("allows configured computer-use tools while keeping callback-controlled mode", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(buildContext({}));

    expect(policy.hasExternalServers).toBe(true);
    expect(policy.hasComputerUseProxy).toBe(true);
    expect(policy.decide("mcp__openclaw-mcp-computer-use__list_apps")).toEqual({
      matched: true,
      allowed: true,
    });
  });

  it("normalizes the reserved computer-use name for native server suppression", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        policies: {
          openclaw: { configuredName: "openclaw", safeName: "openclaw" },
          "openclaw-mcp-COMPUTER-USE": {
            configuredName: " COMPUTER-USE ",
            safeName: "COMPUTER-USE",
          },
        },
      }),
    );

    expect(policy.hasComputerUseProxy).toBe(true);
  });

  it("proxies non-computer MCP servers through the same effective policy", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        config: {
          agents: {
            list: [{ id: "test", tools: { deny: ["mcp__remote__delete"] } }],
          },
        },
        policies: {
          openclaw: { configuredName: "openclaw", safeName: "openclaw" },
          remote: { configuredName: "remote", safeName: "remote" },
        },
      }),
    );

    expect(policy.hasExternalServers).toBe(true);
    expect(policy.hasComputerUseProxy).toBe(false);
    expect(policy.proxyServers).toHaveLength(1);
    expect(policy.decide("mcp__remote__read")).toMatchObject({ allowed: true });
    expect(policy.decide("mcp__remote__delete")).toMatchObject({ allowed: true });
    expectProxyToolAllowed(policy, "delete", false);
  });

  it("uses a custom Claude runtime's canonical model provider policy", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        modelProvider: "custom-provider",
        config: {
          tools: {
            byProvider: {
              "custom-provider": { deny: ["computer-use__list_apps"] },
            },
          },
        },
      }),
    );

    expectProxyToolAllowed(policy, "list_apps", false);
  });

  it("denies MCP requests that are absent from Claude's generated strict config", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(buildContext({}));

    expect(policy.decide("mcp__unknown__read")).toEqual({
      matched: true,
      allowed: false,
      reason: "OpenClaw denied unconfigured MCP tool mcp__unknown__read.",
    });
    expect(policy.decide("Bash")).toEqual({ matched: false });
  });

  it("lets known backend-native MCP tools use the normal Claude permission path", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        nativeServerNames: ["native"],
      }),
    );

    expect(policy.decide("mcp__native__read")).toEqual({ matched: false });
    expect(policy.decide("mcp__unknown__read")).toMatchObject({
      matched: true,
      allowed: false,
    });
  });

  it("leaves unmanaged custom-runtime MCP tools on the native permission path", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(buildContext({ policies: null }));

    expect(policy.hasExternalServers).toBe(false);
    expect(policy.proxyServers).toEqual([]);
    expect(policy.decide("mcp__native__read")).toEqual({ matched: false });
  });

  it("prefers the longest native server match over a managed prefix", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        policies: {
          openclaw: { configuredName: "openclaw", safeName: "openclaw" },
          foo: { configuredName: "foo", safeName: "foo" },
        },
        nativeServerNames: ["foo__native"],
      }),
    );

    expect(policy.decide("mcp__foo__native__delete")).toEqual({ matched: false });
    expect(policy.decide("mcp__foo__read")).toMatchObject({
      matched: true,
      allowed: true,
    });
  });

  it("enforces server-level per-agent deny entries", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        config: {
          agents: {
            list: [
              {
                id: "test",
                tools: { deny: ["computer-use__*"] },
              },
            ],
          },
        },
      }),
    );

    expect(policy.decide("mcp__openclaw-mcp-computer-use__list_apps")).toMatchObject({
      matched: true,
      allowed: true,
    });
    expectProxyToolAllowed(policy, "list_apps", false);
  });

  it("does not treat a bare server name as permission for every MCP tool", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        config: {
          agents: {
            list: [
              {
                id: "test",
                tools: { allow: ["computer-use"] },
              },
            ],
          },
        },
      }),
    );

    expect(policy.decide("mcp__openclaw-mcp-computer-use__list_apps")).toMatchObject({
      matched: true,
      allowed: true,
    });
    expectProxyToolAllowed(policy, "list_apps", false);
  });

  it("does not widen an exact MCP allowlist to the whole server", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        config: {
          agents: {
            list: [
              {
                id: "test",
                tools: { allow: ["mcp__computer-use__list_apps"] },
              },
            ],
          },
        },
      }),
    );

    expect(policy.decide("mcp__openclaw-mcp-computer-use__list_apps")).toMatchObject({
      allowed: true,
    });
    expect(policy.decide("mcp__openclaw-mcp-computer-use__click")).toMatchObject({
      matched: true,
      allowed: true,
    });
    expectProxyToolAllowed(policy, "list_apps", true);
    expectProxyToolAllowed(policy, "click", false);
  });

  it("applies MCP toolFilter before broader agent policy", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        policies: {
          openclaw: { configuredName: "openclaw", safeName: "openclaw" },
          "openclaw-mcp-computer-use": {
            configuredName: "computer-use",
            safeName: "computer-use",
            include: ["list_*", "observe", "click"],
            exclude: ["click"],
          },
        },
      }),
    );

    expect(policy.decide("mcp__openclaw-mcp-computer-use__list_apps")).toMatchObject({
      allowed: true,
    });
    expect(policy.decide("mcp__openclaw-mcp-computer-use__click")).toMatchObject({
      matched: true,
      allowed: false,
      reason: "OpenClaw MCP filter denied mcp__openclaw-mcp-computer-use__click.",
    });
    expect(policy.decide("mcp__openclaw-mcp-computer-use__type")).toMatchObject({
      matched: true,
      allowed: false,
    });
  });

  it("preserves profile alsoAllow for plugin and MCP tools", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        config: {
          agents: {
            list: [
              {
                id: "test",
                tools: {
                  profile: "messaging",
                  alsoAllow: ["group:plugins"],
                },
              },
            ],
          },
        },
      }),
    );

    expect(policy.decide("mcp__openclaw-mcp-computer-use__list_apps")).toMatchObject({
      allowed: true,
    });
  });

  it("applies sender policy resolved from the trusted username", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        senderUsername: "guest",
        config: {
          tools: {
            toolsBySender: {
              "username:guest": { deny: ["computer-use__*"] },
            },
          },
        },
      }),
    );

    expect(policy.decide("mcp__openclaw-mcp-computer-use__list_apps")).toMatchObject({
      matched: true,
      allowed: true,
    });
    expectProxyToolAllowed(policy, "list_apps", false);
  });

  it("applies the effective sandbox tool policy to host-side MCP tools", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        sandboxSessionKey: "agent:test:direct:sandboxed",
        config: {
          agents: {
            defaults: {
              sandbox: { mode: "all" },
            },
          },
        },
      }),
    );

    expect(policy.decide("mcp__openclaw-mcp-computer-use__list_apps")).toMatchObject({
      matched: true,
      allowed: true,
    });
    expectProxyToolAllowed(policy, "list_apps", false);
  });

  it("uses serialized collision aliases instead of reconstructing policy order", () => {
    const policy = resolveClaudeLiveMcpToolPolicy(
      buildContext({
        config: {
          agents: {
            list: [{ id: "test", tools: { deny: ["foo-bar-2__delete"] } }],
          },
        },
        policies: {
          "runtime-colon": {
            configuredName: "foo:bar",
            safeName: "foo-bar-2",
          },
          "runtime-dash": {
            configuredName: "foo-bar",
            safeName: "foo-bar",
          },
        },
      }),
    );

    const colonProxy = policy.proxyServers.find((server) => server.runtimeName === "runtime-colon");
    const dashProxy = policy.proxyServers.find((server) => server.runtimeName === "runtime-dash");
    expect(colonProxy).toBeDefined();
    expect(dashProxy).toBeDefined();
    expect(isClaudeMcpProxyToolAllowed(colonProxy!, "delete")).toBe(false);
    expect(isClaudeMcpProxyToolAllowed(dashProxy!, "delete")).toBe(true);
  });
});
