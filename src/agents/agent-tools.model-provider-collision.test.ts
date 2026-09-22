/**
 * Tests provider-native tool collision policy.
 * Protects OpenClaw web_search routing when provider/model compatibility also
 * advertises native search support.
 */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createCodeModeCatalogProjection } from "./code-mode-catalog.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [{ name: "browser" }],
}));

const HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING = "html-entities";
const XAI_TOOL_SCHEMA_PROFILE = "xai";

const baseTools = [
  { name: "read" },
  { name: "web_search" },
  { name: "exec" },
] as unknown as AnyAgentTool[];

const testing = {
  applyModelProviderToolPolicy(
    requestedTools: AnyAgentTool[],
    options?: NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>,
  ): AnyAgentTool[] {
    const actualTools = createOpenClawCodingTools({
      ...options,
      cwd: "/tmp/openclaw-agent-tools-policy-test",
      workspaceDir: "/tmp/openclaw-agent-tools-policy-test",
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: true,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: true,
      },
    });
    const actualToolsByName = new Map(actualTools.map((tool) => [tool.name, tool]));
    return requestedTools.flatMap((tool) => {
      const actualTool = actualToolsByName.get(tool.name);
      return actualTool ? [actualTool] : [];
    });
  },
};

function toolNames(tools: AnyAgentTool[]): string[] {
  return tools.map((tool) => tool.name);
}

describe("applyModelProviderToolPolicy", () => {
  it("keeps web_search for non-xAI models", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
      modelCompat: {},
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("keeps web_search for OpenRouter xAI model ids so OpenClaw tool routing stays authoritative", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
      modelCompat: {
        toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
        toolCallArgumentsEncoding: HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
      },
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("keeps web_search for direct xai-capable models too", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
      modelCompat: {
        toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
      },
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it.each<{
    label: string;
    provider?: string;
    baseUrl: string;
    modelBaseUrl?: string;
    native: boolean;
    plugins?: OpenClawConfig["plugins"];
  }>([
    { label: "automatic", provider: undefined, baseUrl: "https://api.openai.com/v1", native: true },
    {
      label: "explicit managed",
      provider: "brave",
      baseUrl: "https://api.openai.com/v1",
      native: false,
    },
    {
      label: "custom endpoint",
      provider: undefined,
      baseUrl: "https://proxy.example/v1",
      native: false,
    },
    {
      label: "resolved custom endpoint",
      provider: undefined,
      baseUrl: "https://api.openai.com/v1",
      modelBaseUrl: "https://proxy.example/v1",
      native: false,
    },
    {
      label: "resolved official endpoint",
      provider: undefined,
      baseUrl: "https://proxy.example/v1",
      modelBaseUrl: "https://api.openai.com/v1",
      native: true,
    },
    {
      label: "enabled plugin",
      plugins: { allow: ["openai"] },
      baseUrl: "https://api.openai.com/v1",
      native: true,
    },
    ...[
      { label: "disabled plugin", plugins: { entries: { openai: { enabled: false } } } },
      { label: "globally disabled plugins", plugins: { enabled: false } },
      { label: "denied plugin", plugins: { deny: ["openai"] } },
      { label: "unlisted plugin", plugins: { allow: ["brave"] } },
    ].map(({ label, plugins }) => ({
      label,
      plugins,
      provider: undefined,
      baseUrl: "https://api.openai.com/v1",
      native: false,
    })),
  ])(
    "uses one search route before tool discovery for OpenAI $label",
    ({ provider, baseUrl, modelBaseUrl, native, plugins }) => {
      const filtered = testing.applyModelProviderToolPolicy(baseTools, {
        config: {
          plugins,
          tools: { web: { search: { provider } } },
          models: { providers: { openai: { api: "openai-responses", baseUrl, models: [] } } },
        },
        modelProvider: "openai",
        modelApi: "openai-responses",
        modelBaseUrl,
        modelId: "gpt-5.4",
      });

      expect(toolNames(filtered)).toEqual(
        native ? ["read", "exec"] : ["read", "web_search", "exec"],
      );
      const catalogRef = createToolSearchCatalogRef();
      registerHeadlessToolSearchCatalog({ catalogRef, tools: filtered });
      const projection = createCodeModeCatalogProjection(catalogRef.current?.entries ?? []);
      expect(projection.byCallableName.has("web_search")).toBe(!native);
    },
  );

  it("removes managed web_search when native Codex search is active", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
      modelProvider: "gateway",
      modelApi: "openai-chatgpt-responses",
      modelId: "gpt-5.4",
    });

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("can keep managed web_search for Codex app-server dynamic tools", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
      modelProvider: "gateway",
      modelApi: "openai-chatgpt-responses",
      modelId: "gpt-5.4",
      suppressManagedWebSearch: false,
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("removes managed web_search for direct Codex models when auth is available", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
        auth: {
          profiles: {
            "openai:default": {
              provider: "openai",
              mode: "oauth",
            },
          },
        },
      },
      modelProvider: "openai",
      modelApi: "openai-chatgpt-responses",
      modelId: "gpt-5.4",
    });

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("keeps managed web_search when Codex native search cannot activate", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
      modelProvider: "openai",
      modelApi: "openai-chatgpt-responses",
      modelId: "gpt-5.4",
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("drops heavyweight tools when the experimental lean local-model flag is enabled", () => {
    const filtered = testing.applyModelProviderToolPolicy(
      [
        { name: "read" },
        { name: "browser" },
        { name: "automations" },
        { name: "message" },
        { name: "exec" },
      ] as unknown as AnyAgentTool[],
      {
        config: {
          agents: {
            defaults: {
              experimental: {
                localModelLean: true,
              },
            },
          },
        },
        modelProvider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
      },
    );

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("drops heavyweight tools when lean local-model mode is enabled for the current agent", () => {
    const filtered = testing.applyModelProviderToolPolicy(
      [
        { name: "read" },
        { name: "browser" },
        { name: "automations" },
        { name: "message" },
        { name: "exec" },
      ] as unknown as AnyAgentTool[],
      {
        config: {
          agents: {
            list: [
              {
                id: "gemma",
                experimental: {
                  localModelLean: true,
                },
              },
            ],
          },
        },
        agentId: "gemma",
        modelProvider: "lmstudio",
        modelApi: "openai-compatible",
        modelId: "gemma-4-e4b-it",
      },
    );

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("drops heavyweight tools when lean local-model mode is enabled for the default agent", () => {
    const filtered = testing.applyModelProviderToolPolicy(
      [
        { name: "read" },
        { name: "browser" },
        { name: "automations" },
        { name: "message" },
        { name: "exec" },
      ] as unknown as AnyAgentTool[],
      {
        config: {
          agents: {
            list: [
              {
                id: "gemma",
                default: true,
                experimental: {
                  localModelLean: true,
                },
              },
            ],
          },
        },
        modelProvider: "lmstudio",
        modelApi: "openai-compatible",
        modelId: "gemma-4-e4b-it",
      },
    );

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("drops heavyweight tools when lean local-model mode is enabled for the session agent", () => {
    const filtered = testing.applyModelProviderToolPolicy(
      [
        { name: "read" },
        { name: "browser" },
        { name: "automations" },
        { name: "message" },
        { name: "exec" },
      ] as unknown as AnyAgentTool[],
      {
        config: {
          agents: {
            list: [
              {
                id: "main",
                experimental: {
                  localModelLean: false,
                },
              },
              {
                id: "gemma",
                experimental: {
                  localModelLean: true,
                },
              },
            ],
          },
        },
        sessionKey: "agent:gemma:main",
        modelProvider: "lmstudio",
        modelApi: "openai-compatible",
        modelId: "gemma-4-e4b-it",
      },
    );

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("lets a current agent disable inherited lean local-model mode", () => {
    const filtered = testing.applyModelProviderToolPolicy(
      [
        { name: "read" },
        { name: "browser" },
        { name: "automations" },
        { name: "message" },
        { name: "exec" },
      ] as unknown as AnyAgentTool[],
      {
        config: {
          agents: {
            defaults: {
              experimental: {
                localModelLean: true,
              },
            },
            list: [
              {
                id: "main",
                experimental: {
                  localModelLean: false,
                },
              },
            ],
          },
        },
        agentId: "main",
        modelProvider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
      },
    );

    expect(toolNames(filtered)).toEqual(["read", "browser", "automations", "message", "exec"]);
  });

  it("keeps heavyweight tools when the experimental lean local-model flag is not enabled", () => {
    const filtered = testing.applyModelProviderToolPolicy(
      [
        { name: "read" },
        { name: "browser" },
        { name: "automations" },
        { name: "message" },
        { name: "exec" },
      ] as unknown as AnyAgentTool[],
      {
        config: {
          agents: {
            defaults: {
              experimental: {
                localModelLean: false,
              },
            },
          },
        },
        modelProvider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
      },
    );

    expect(toolNames(filtered)).toEqual(["read", "browser", "automations", "message", "exec"]);
  });
});
