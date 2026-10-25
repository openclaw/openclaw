import { GetPromptResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fixtureCatalog, fixtureRuntime } from "./agent-bundle-mcp-fixture.test-support.js";
import {
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { consumeMcpCodeModeGuestResult } from "./mcp-content.js";

afterEach(() => vi.restoreAllMocks());

const textBlock = (text: string) => ({ type: "text" as const, text });
const promptMessage = (role: "user" | "assistant", text: string) => ({
  role,
  content: textBlock(text),
});

// Regression #76063: configured MCP tools must survive materialization, policy, and SDK splitting.
function makeConfiguredRuntime(toolNames = ["send_reply", "list_inbox"], serverName = "userMcp") {
  const catalog = fixtureCatalog(
    serverName,
    toolNames.map((toolName) => ({ toolName })),
  );
  return fixtureRuntime(() => catalog, { peekCatalog: () => catalog });
}

function requestToolNames(
  tools: Parameters<typeof applyFinalEffectiveToolPolicy>[0]["bundledTools"],
  config: OpenClawConfig = { tools: { profile: "coding" } },
) {
  return toToolDefinitions(
    applyFinalEffectiveToolPolicy({
      bundledTools: tools,
      config,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({ config }),
      warn: () => {},
    }),
    undefined,
    undefined,
  ).map((tool) => tool.name);
}

async function configuredToolNames(cfg: OpenClawConfig): Promise<string[]> {
  const runtimeModule = await import("./agent-bundle-mcp-runtime.js");
  vi.spyOn(runtimeModule, "createSessionMcpRuntime").mockImplementationOnce(() =>
    makeConfiguredRuntime(),
  );
  const runtime = await createBundleMcpToolRuntime({
    workspaceDir: "/workspace",
    cfg,
  });
  return requestToolNames(runtime.tools, cfg);
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
      const names = await configuredToolNames({
        tools,
        mcp: { servers: { userMcp: { command: "node", args: ["user-mcp.mjs"] } } },
      });
      expect(names).toEqual(allowed ? ["userMcp__list_inbox", "userMcp__send_reply"] : []);
    },
  );

  it("preserves public resource and multimodal prompt results without leaking private metadata", async () => {
    const base = makeConfiguredRuntime([], "knowledge");
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
              ...textBlock("Summarize MCP"),
              annotations: { audience: ["assistant"] },
              _meta: { promptBlock: "preserved" },
            },
          },
          { role: "user", content: image },
          promptMessage("assistant", "An example answer."),
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
          ...["Brief the user", "user:", "Summarize MCP", "user:"].map(textBlock),
          image,
          ...["assistant:", "An example answer."].map(textBlock),
        ]);
      } else {
        expect(result.content).toEqual([
          textBlock(JSON.stringify(publicResults[operation], null, 2)),
        ]);
      }
      expect(consumeMcpCodeModeGuestResult(result)).toEqual(publicResults[operation]);
      expect(result.details).toMatchObject({
        mcpServer: "knowledge",
        mcpOperation: operation,
        untrustedMcpOutput: true,
      });
      expect(tool.resultContentSource).toBe("network");
      expect(privateResults[operation]._meta).toEqual({
        privateState: `${operation}-must-not-leak`,
      });
      if (operation === "prompts_get") {
        prompt.description = "A later server-side edit";
        expect(consumeMcpCodeModeGuestResult(result)).toEqual(publicResults.prompts_get);
      }
    }

    await expect(
      runtime.tools
        .find((tool) => tool.name === "knowledge__prompts_get")!
        .execute("call-prompt", { name: "brief", arguments: { count: 1 } }, undefined, undefined),
    ).rejects.toThrow("arguments.count must be a string");
  });
});
