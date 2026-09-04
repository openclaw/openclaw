/** Tests configured MCP tools survive policy/splitting to the outbound request boundary. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import type { McpCatalogTool, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import {
  applyFinalEffectiveToolPolicy,
  createBundleMcpServerPolicyMatcher,
} from "./embedded-agent-runner/effective-tool-policy.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { splitSdkTools } from "./embedded-agent-runner/tool-split.js";

// Regression coverage for #76063. The reporter's evidence was a captured
// outbound provider request body that contained only built-in OpenClaw tools
// and no `server__*` MCP tool definitions, even though `cfg.mcp.servers`
// declared healthy stdio servers. The materialize/policy/split units each
// have their own focused tests, but ClawSweeper noted that the full request-
// boundary path was uncovered: configured (`cfg.mcp.servers.<name>`) tools
// must materialize, survive `applyFinalEffectiveToolPolicy`, and reach
// `splitSdkTools().customTools` (the value passed to the SDK as
// `customTools`, which is what the provider receives). This test asserts
// that boundary behavior with a fake session MCP runtime so it can run
// against current main without booting a real stdio child.

function makeConfiguredRuntime(
  params: {
    serverName?: string;
    toolNames?: string[];
  } = {},
): SessionMcpRuntime {
  const serverName = params.serverName ?? "userMcp";
  const toolNames = params.toolNames ?? ["list_inbox", "send_reply"];
  const tools: McpCatalogTool[] = toolNames.map((toolName) => ({
    serverName,
    safeServerName: serverName,
    toolName,
    description: `${serverName}.${toolName}`,
    inputSchema: { type: "object", properties: {} },
    fallbackDescription: `${serverName}.${toolName}`,
  }));
  return {
    sessionId: "session-request-boundary",
    workspaceDir: "/workspace",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
        },
      },
      tools,
    }),
    peekCatalog: () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
        },
      },
      tools,
    }),
    callTool: async () => ({
      content: [{ type: "text", text: "FROM-CONFIG" }],
      isError: false,
    }),
    dispose: async () => {},
  };
}

async function buildConfiguredMcpToolNamesAtRequestBoundary(params: {
  cfg: OpenClawConfig;
  serverName?: string;
  toolNames?: string[];
  toolsAllow?: string[];
}): Promise<string[]> {
  const runtime = await createBundleMcpToolRuntime({
    workspaceDir: "/workspace",
    cfg: params.cfg,
    createRuntime: () => makeConfiguredRuntime(params),
  });
  const filtered = applyFinalEffectiveToolPolicy({
    bundledTools: applyEmbeddedAttemptToolsAllow(runtime.tools, params.toolsAllow, {
      toolMeta: (tool) => getPluginToolMeta(tool),
    }),
    config: params.cfg,
    conversationCapabilityProfile: resolveConversationCapabilityProfile({ config: params.cfg }),
    warn: () => {},
  });
  const { customTools } = splitSdkTools({ tools: filtered, sandboxEnabled: false });
  return customTools.map((tool) => tool.name);
}

describe("configured MCP tools reach the request boundary (#76063)", () => {
  it("includes server__* tools in customTools under the coding profile", async () => {
    const names = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: {
        tools: { profile: "coding" },
        mcp: {
          servers: {
            userMcp: {
              command: "node",
              args: ["user-mcp.mjs"],
            },
          },
        },
      },
    });

    expect(names).toEqual(["userMcp__list_inbox", "userMcp__send_reply"]);
  });

  it("includes server__* tools in customTools under the messaging profile", async () => {
    const names = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: {
        tools: { profile: "messaging" },
        mcp: {
          servers: {
            userMcp: {
              command: "node",
              args: ["user-mcp.mjs"],
            },
          },
        },
      },
    });

    expect(names).toEqual(["userMcp__list_inbox", "userMcp__send_reply"]);
  });

  it("removes configured server__* tools from customTools under the minimal profile", async () => {
    const names = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: {
        tools: { profile: "minimal" },
        mcp: {
          servers: {
            userMcp: {
              command: "node",
              args: ["user-mcp.mjs"],
            },
          },
        },
      },
    });

    expect(names).toEqual([]);
  });

  it("respects an explicit tools.deny: ['bundle-mcp'] entry under the coding profile", async () => {
    const names = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: {
        tools: { profile: "coding", deny: ["bundle-mcp"] },
        mcp: {
          servers: {
            userMcp: {
              command: "node",
              args: ["user-mcp.mjs"],
            },
          },
        },
      },
    });

    expect(names).toEqual([]);
  });

  it("preserves materialize ordering at the request boundary so prompt cache keys stay stable", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeConfiguredRuntime({
        toolNames: ["zeta_tool", "alpha_tool", "mu_tool"],
      }),
    });
    const cfg: OpenClawConfig = { tools: { profile: "coding" } };
    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: runtime.tools,
      config: cfg,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({ config: cfg }),
      warn: () => {},
    });
    const { customTools } = splitSdkTools({ tools: filtered, sandboxEnabled: false });

    expect(customTools.map((tool) => tool.name)).toEqual([
      "userMcp__alpha_tool",
      "userMcp__mu_tool",
      "userMcp__zeta_tool",
    ]);
  });
});

// Regression coverage for #137398. A server whose catalog load failed exposes no
// tool names, so its outage diagnostic is admitted by the server namespace. That
// decision must agree with the one the same policy makes about that server's
// tools: an operator who could still reach a memos tool learns memos is down
// (otherwise the model keeps retrying a generic lookup miss), and one who could
// never reach any memos tool learns nothing about it.
describe("failed MCP server outages follow the same policy as that server's tools (#137398)", () => {
  const mcp = { servers: { memos: { command: "node", args: ["memos.mjs"] } } };
  const outageCases: Array<{
    label: string;
    tools?: OpenClawConfig["tools"];
    toolsAllow?: string[];
    visible: boolean;
  }> = [
    { label: "the coding profile", tools: { profile: "coding" }, visible: true },
    { label: "the minimal profile", tools: { profile: "minimal" }, visible: false },
    {
      label: "tools.deny: ['bundle-mcp']",
      tools: { profile: "coding", deny: ["bundle-mcp"] },
      visible: false,
    },
    {
      label: "an allowlist naming one memos tool",
      tools: { allow: ["memos__read_note"] },
      visible: true,
    },
    {
      label: "an exact deny of one memos tool",
      tools: { profile: "coding", deny: ["memos__read_note"] },
      visible: true,
    },
    {
      label: "a deny glob covering part of the memos namespace",
      tools: { profile: "coding", deny: ["memos__s*"] },
      visible: true,
    },
    {
      label: "a deny glob covering the whole memos namespace",
      tools: { profile: "coding", deny: ["memos__*"] },
      visible: false,
    },
    {
      label: "an allowlist naming another server",
      tools: { allow: ["notes__lookup"] },
      visible: false,
    },
    {
      label: "an allow and a deny naming the same memos tool",
      tools: { allow: ["memos__read_note"], deny: ["memos__read_note"] },
      visible: false,
    },
    {
      label: "a runtime allowlist that shares no memos tool with the config allowlist",
      tools: { allow: ["memos__read_note"] },
      toolsAllow: ["memos__write_note"],
      visible: false,
    },
    {
      label: "a runtime allowlist naming one memos tool",
      toolsAllow: ["memos__read_note"],
      visible: true,
    },
    {
      label: "a runtime allowlist naming another server",
      toolsAllow: ["notes__lookup"],
      visible: false,
    },
  ];

  it.each(outageCases)("names the memos outage under $label: $visible", async (testCase) => {
    const config: OpenClawConfig = { ...(testCase.tools ? { tools: testCase.tools } : {}), mcp };
    const admitsMcpServer = createBundleMcpServerPolicyMatcher({
      conversationCapabilityProfile: resolveConversationCapabilityProfile({ config }),
      toolsAllow: testCase.toolsAllow,
    });
    const namesWhenHealthy = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: config,
      serverName: "memos",
      toolNames: ["read_note", "write_note"],
      toolsAllow: testCase.toolsAllow,
    });

    expect(admitsMcpServer("memos")).toBe(testCase.visible);
    expect(namesWhenHealthy.length > 0).toBe(testCase.visible);
  });
});
