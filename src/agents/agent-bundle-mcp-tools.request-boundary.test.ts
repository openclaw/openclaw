/** Tests configured MCP tools survive policy/splitting to the outbound request boundary. */
import { GetPromptResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import { catalogTool, makeCatalog, makeMcpRuntime } from "./agent-bundle-mcp-tools.test-support.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { consumeMcpCodeModeGuestResult } from "./mcp-content.js";

afterEach(() => vi.restoreAllMocks());

// Regression #76063: configured MCP tools must survive materialization, policy, and SDK splitting.
function makeConfiguredRuntime(
  params: {
    serverName?: string;
    toolNames?: string[];
  } = {},
): SessionMcpRuntime {
  const serverName = params.serverName ?? "userMcp";
  // Deliberately unsorted: the outbound policy path must preserve catalog ordering.
  const toolNames = params.toolNames ?? ["send_reply", "zeta_tool", "list_inbox"];
  const tools = toolNames.map((toolName) =>
    catalogTool(serverName, toolName, {
      description: `${serverName}.${toolName}`,
      fallbackDescription: `${serverName}.${toolName}`,
    }),
  );
  return makeMcpRuntime(
    () => makeCatalog(serverName, tools),
    () => ({
      content: [{ type: "text", text: "FROM-CONFIG" }],
      isError: false,
    }),
    { sessionId: "session-request-boundary", workspaceDir: "/workspace" },
  );
}

async function requestToolNames(cfg: OpenClawConfig): Promise<string[]> {
  const runtimeModule = await import("./agent-bundle-mcp-runtime.js");
  const createRuntime = vi
    .spyOn(runtimeModule, "createSessionMcpRuntime")
    .mockImplementationOnce(() => makeConfiguredRuntime());
  const runtime = await createBundleMcpToolRuntime({
    workspaceDir: "/workspace",
    cfg,
  });
  expect(createRuntime).toHaveBeenCalledOnce();
  expect(createRuntime).toHaveBeenCalledWith({
    sessionId: expect.stringMatching(/^bundle-mcp:/),
    workspaceDir: "/workspace",
    cfg,
  });
  const filtered = applyFinalEffectiveToolPolicy({
    bundledTools: runtime.tools,
    config: cfg,
    conversationCapabilityProfile: resolveConversationCapabilityProfile({ config: cfg }),
    warn: () => {},
  });
  return toToolDefinitions(filtered, undefined, undefined).map((tool) => tool.name);
}

describe("configured MCP tools reach the request boundary (#76063)", () => {
  it.each([
    { name: "coding", tools: { profile: "coding" }, allowed: true },
    { name: "messaging", tools: { profile: "messaging" }, allowed: true },
    { name: "minimal", tools: { profile: "minimal" }, allowed: false },
    { name: "explicit deny", tools: { profile: "coding", deny: ["bundle-mcp"] }, allowed: false },
  ] satisfies Array<{ name: string; tools: OpenClawConfig["tools"]; allowed: boolean }>)(
    "applies $name policy to configured server__* tools at the request boundary",
    async ({ tools, allowed }) => {
      const names = await requestToolNames({
        tools,
        mcp: { servers: { userMcp: { command: "node", args: ["user-mcp.mjs"] } } },
      });
      expect(names).toEqual(
        allowed ? ["userMcp__list_inbox", "userMcp__send_reply", "userMcp__zeta_tool"] : [],
      );
    },
  );

  it("exposes MCP resource and prompt utility tools when advertised", async () => {
    const base = makeConfiguredRuntime({ toolNames: [], serverName: "knowledge" });
    const catalog = await base.getCatalog();
    catalog.servers.knowledge!.resources = { listChanged: true };
    catalog.servers.knowledge!.prompts = { listChanged: true };
    const image = {
      type: "image",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      mimeType: "image/png",
    } as const;
    const publicResults = {
      prompts_get: {
        description: "Brief the user",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Summarize MCP",
              annotations: { audience: ["assistant"] },
              _meta: { promptBlock: "preserved" },
            },
          },
          { role: "user", content: image },
          { role: "assistant", content: { type: "text", text: "An example answer." } },
        ],
      },
      prompts_list: {
        prompts: [{ name: "brief", _meta: { promptEntry: "preserved" } }],
        nextCursor: "prompt-page-two",
      },
      resources_list: {
        resources: [
          {
            uri: "memo://one",
            name: "memo",
            annotations: { priority: 0.5 },
            _meta: { resourceEntry: "preserved" },
          },
        ],
        nextCursor: "resource-page-two",
      },
      resources_read: {
        contents: [{ uri: "memo://one", text: "memo text", _meta: { content: "preserved" } }],
      },
    };
    const privateResults = Object.fromEntries(
      Object.entries(publicResults).map(([operation, value]) => [
        operation,
        { ...value, _meta: { privateState: `${operation}-must-not-leak` } },
      ]),
    );
    const prompt = GetPromptResultSchema.parse(privateResults.prompts_get);
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: {
        ...base,
        getCatalog: async () => catalog,
        listResources: async () => privateResults.resources_list,
        readResource: async () => privateResults.resources_read,
        listPrompts: async () => privateResults.prompts_list,
        getPrompt: async () => prompt,
      },
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      "knowledge__prompts_get",
      "knowledge__prompts_list",
      "knowledge__resources_list",
      "knowledge__resources_read",
    ]);

    for (const [operation, args] of [
      ["prompts_get", { name: "brief" }],
      ["prompts_list", {}],
      ["resources_list", {}],
      ["resources_read", { uri: "memo://one" }],
    ] as const) {
      const tool = expectDefined(
        runtime.tools.find((candidate) => candidate.name === `knowledge__${operation}`),
        `${operation} utility tool`,
      );
      const result = await tool.execute(`call-${operation}`, args, undefined, undefined);
      if (operation === "prompts_get") {
        expect(result.content).toEqual([
          { type: "text", text: "Brief the user" },
          { type: "text", text: "user:" },
          { type: "text", text: "Summarize MCP" },
          { type: "text", text: "user:" },
          image,
          { type: "text", text: "assistant:" },
          { type: "text", text: "An example answer." },
        ]);
        prompt.description = "A later server-side edit";
      } else {
        expect(result.content).toEqual([
          { type: "text", text: JSON.stringify(publicResults[operation], null, 2) },
        ]);
      }
      expect(consumeMcpCodeModeGuestResult(result)).toEqual(publicResults[operation]);
      expect(result.details).toMatchObject({
        mcpServer: "knowledge",
        mcpOperation: operation,
        untrustedMcpOutput: true,
      });
      expect(tool.resultContentSource).toBe("network");
      expect(expectDefined(privateResults[operation], `${operation} private source`)._meta).toEqual(
        {
          privateState: `${operation}-must-not-leak`,
        },
      );
    }

    await expect(
      runtime.tools
        .find((tool) => tool.name === "knowledge__prompts_get")!
        .execute("call-prompt", { name: "brief", arguments: { count: 1 } }, undefined, undefined),
    ).rejects.toThrow("arguments.count must be a string");
  });
});
