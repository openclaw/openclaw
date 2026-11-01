import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { buildBundleMcpToolsFromCatalog } from "./agent-bundle-mcp-materialize.js";
import { assignSafeServerNames } from "./agent-bundle-mcp-names.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { prepareNativeMcpPolicy } from "./native-mcp-policy.js";

function makeTool(
  toolName: string,
  fallbackDescription: string,
  overrides: Partial<McpToolCatalog["tools"][number]> = {},
): McpToolCatalog["tools"][number] {
  return {
    serverName: "docs!",
    safeServerName: "docs",
    toolName,
    inputSchema: Type.Object({}),
    fallbackDescription,
    ...overrides,
  };
}

function makeCatalog(
  servers: [string, string, number][],
  tools: McpToolCatalog["tools"],
  extra: Partial<McpToolCatalog> = {},
): McpToolCatalog {
  return {
    version: 1,
    generatedAt: 1,
    servers: Object.fromEntries(
      servers.map(([serverName, safeServerName, toolCount]) => [
        serverName,
        { serverName, safeServerName, launchSummary: "test", toolCount },
      ]),
    ),
    tools,
    ...extra,
  };
}

function catalog(): McpToolCatalog {
  const tools = [
    makeTool("read_docs", "read"),
    makeTool("delete_docs", "delete", { excludedFromOpenClawCatalog: true }),
    makeTool("read_docs", "other read", {
      serverName: "docs?",
      safeServerName: "docs-2",
      deniedBySession: true,
    }),
    makeTool("app_only", "app only", { uiVisibility: ["app"] }),
  ];
  return makeCatalog(
    [
      ["docs!", "docs", 1],
      ["docs?", "docs-2", 0],
    ],
    [tools[0]!],
    {
      sessionDeniedTools: [tools[2]!],
      policyTools: tools,
    },
  );
}

function prepare(
  value = catalog(),
  config?: Parameters<typeof prepareNativeMcpPolicy>[0]["config"],
  runtimeToolsAllow?: string[],
) {
  const workspaceDir = "/tmp/openclaw-native-mcp-policy";
  const runtime: SessionMcpRuntime = {
    sessionId: "session-1",
    workspaceDir,
    configFingerprint: "test",
    createdAt: 1,
    lastUsedAt: 1,
    getCatalog: async () => value,
    peekCatalog: () => value,
    markUsed: () => {},
    callTool: async () => ({ content: [] }),
    dispose: async () => {},
  };
  return prepareNativeMcpPolicy({
    runtime,
    config,
    workspaceDir,
    capabilityProfile: resolveConversationCapabilityProfile({ config }),
    runtimeToolsAllow,
    warn: () => {},
  });
}

function callableName(value: McpToolCatalog, toolName: string) {
  const name = buildBundleMcpToolsFromCatalog({ catalog: value }).find(
    (tool) => getPluginToolMeta(tool)?.mcp?.toolName === toolName,
  )?.name;
  expect(name).toBeDefined();
  if (!name) {
    throw new Error("expected callable policy name");
  }
  return name;
}

describe("prepareNativeMcpPolicy", () => {
  it("keeps default callable tools while denying hidden native inventory", async () => {
    const prepared = await prepare();

    expect(prepared.servers["docs!"]).toMatchObject({
      safeServerName: "docs",
      allowedTools: ["read_docs"],
      deniedTools: ["app_only", "delete_docs"],
    });
    expect(prepared.servers["docs?"]).toMatchObject({
      safeServerName: "docs-2",
      allowedTools: [],
      deniedTools: ["read_docs"],
    });
  });

  it("treats an empty runtime allowlist as an exact deny-all cap", async () => {
    const prepared = await prepare(catalog(), undefined, []);
    expect(Object.values(prepared.servers).flatMap((server) => server.allowedTools)).toEqual([]);
  });

  it("preserves callable identities when an App-only raw name collides", async () => {
    const serverNames = [
      "docs.production.endpoint.with.a.long.shared.prefix.alpha",
      "docs.production.endpoint.with.a.long.shared.prefix.beta",
    ];
    const safeNames = assignSafeServerNames(serverNames);
    const rawTools = [
      "read.docs.with.a.long.shared.prefix.alpha",
      "read:docs:with:a:long:shared:prefix:alpha",
    ];
    const identity = {
      serverName: serverNames[1]!,
      safeServerName: safeNames.get(serverNames[1]!)!,
    };
    const policyTools = [
      ...rawTools.map((toolName, index) =>
        makeTool(toolName, toolName, {
          ...identity,
          ...(index === 1 ? { uiVisibility: ["app" as const] } : {}),
        }),
      ),
      makeTool("read_safe", "read safe", identity),
    ];
    const collisionCatalog = makeCatalog(
      serverNames.map((name) => [
        name,
        safeNames.get(name)!,
        name === serverNames[1] ? policyTools.length : 0,
      ]),
      policyTools,
      { policyTools },
    );
    const deniedName = callableName(collisionCatalog, rawTools[0]!);
    const config = {
      tools: {
        allow: [`${safeNames.get(serverNames[1]!)}__*`],
        deny: [deniedName],
      },
    };
    const prepared = await prepare(collisionCatalog, config);

    expect(prepared.servers[serverNames[1]!]?.allowedTools).toEqual(["read_safe"]);
    expect(prepared.servers[serverNames[1]!]?.deniedTools).toEqual(rawTools);
    expect(safeNames.get(serverNames[0]!)).not.toBe(safeNames.get(serverNames[1]!));
  });

  it("reserves callable identities before every non-callable policy row", async () => {
    const callableTool = makeTool("read:value", "callable", { serverName: "docs" });
    const readTool = makeTool("read_safe", "read safe", { serverName: "docs" });
    const hiddenTools = ["read value", "read.value", "read.value", "read/value"].map((toolName) =>
      makeTool(toolName, "hidden policy inventory", {
        serverName: "docs",
        excludedFromOpenClawCatalog: true,
      }),
    );
    const collisionCatalog = makeCatalog([["docs", "docs", 2]], [callableTool, readTool], {
      policyTools: [...hiddenTools, callableTool, readTool],
    });
    const policyName = callableName(collisionCatalog, callableTool.toolName);
    const config = { tools: { allow: ["docs__*"], deny: [policyName] } };

    const prepared = await prepare(collisionCatalog, config);

    expect(prepared.servers.docs?.allowedTools).toEqual(["read_safe"]);
    expect(prepared.servers.docs?.deniedTools).toEqual([
      "read value",
      "read.value",
      "read/value",
      "read:value",
    ]);
  });
});
