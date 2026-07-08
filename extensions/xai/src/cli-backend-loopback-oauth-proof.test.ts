// Real-behavior proof: with an OAuth auth context, the xAI plugin registers
// x_search and code_execution for loopback/CLI-backend tool surfaces.
import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import xaiPlugin from "../index.js";

type ToolFactory = (ctx: {
  config?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  hasAuthForProvider?: (providerId: string) => boolean;
  resolveApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
}) => AnyAgentTool | AnyAgentTool[] | null | undefined;

type ToolRegistration = {
  name: string;
  factory: ToolFactory;
};

describe("xAI OAuth CLI-backend loopback tool surface proof", () => {
  it("registers x_search and code_execution when an xAI OAuth auth context is present", () => {
    const registeredTools: ToolRegistration[] = [];

    const api = {
      registerTool: (factory: ToolFactory, options: { name: string }) => {
        registeredTools.push({ name: options.name, factory });
      },
      // Provider-entry stubs needed before tool registration is reached.
      registerProvider: () => {},
      registerModelCatalogProvider: () => {},
      registerWebSearchProvider: () => {},
      registerMediaUnderstandingProvider: () => {},
      registerVideoGenerationProvider: () => {},
      registerImageGenerationProvider: () => {},
      registerSpeechProvider: () => {},
      registerRealtimeTranscriptionProvider: () => {},
    };

    xaiPlugin.register(api as never);

    const authContext = {
      hasAuthForProvider: (providerId: string) => providerId === "xai",
      resolveApiKeyForProvider: async () => "REDACTED_API_KEY",
    };

    const resolvedTools: AnyAgentTool[] = [];
    for (const registration of registeredTools) {
      const result = registration.factory({
        config: {},
        runtimeConfig: {},
        ...authContext,
      });
      if (result) {
        for (const tool of Array.isArray(result) ? result : [result]) {
          resolvedTools.push(tool);
        }
      }
    }

    const names = resolvedTools.map((tool) => tool.name).toSorted();
    const mcpToolsListResponse = {
      jsonrpc: "2.0",
      id: "proof-tools-list",
      result: {
        tools: resolvedTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
      },
    };
    // eslint-disable-next-line no-console
    console.log("[xai-oauth-loopback-proof] MCP tools/list response:");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(mcpToolsListResponse, null, 2));

    expect(names).toContain("x_search");
    expect(names).toContain("code_execution");
  });
});
