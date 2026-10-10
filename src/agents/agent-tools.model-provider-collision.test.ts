import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createCodeModeCatalogProjection } from "./code-mode-catalog.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [{ name: "browser" }],
}));

const baseTools = ["read", "web_search", "exec"];

beforeEach(() => {
  for (const name of listKnownProviderAuthEnvVarNamesCore()) {
    vi.stubEnv(name, undefined);
  }
  // Route selection needs a configured managed fallback without forcing a provider.
  vi.stubEnv("BRAVE_API_KEY", "test-managed-search-key");
});
afterEach(() => vi.unstubAllEnvs());

function selectedTools(
  requestedTools: string[],
  options?: NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>,
) {
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
  return requestedTools.flatMap((name) => {
    const tool = actualTools.find((candidate) => candidate.name === name);
    return tool ? [tool] : [];
  });
}

function toolNames(tools: { name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

describe("applyModelProviderToolPolicy", () => {
  it("keeps web_search for OpenRouter xAI model ids so OpenClaw tool routing stays authoritative", () => {
    const filtered = selectedTools(baseTools, {
      modelCompat: {
        toolSchemaProfile: "xai",
        toolCallArgumentsEncoding: "html-entities",
      },
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it.each<{
    label: string;
    baseUrl: string;
    modelBaseUrl?: string;
    native: boolean;
    plugins?: OpenClawConfig["plugins"];
  }>([
    {
      label: "resolved custom endpoint",
      baseUrl: "https://api.openai.com/v1",
      modelBaseUrl: "https://proxy.example/v1",
      native: false,
    },

    {
      label: "disabled plugin",
      plugins: { entries: { openai: { enabled: false } } },
      baseUrl: "https://api.openai.com/v1",
      native: false,
    },
  ])(
    "uses one search route before tool discovery for OpenAI $label",
    ({ baseUrl, modelBaseUrl, native, plugins }) => {
      const filtered = selectedTools(baseTools, {
        config: {
          plugins,
          tools: { web: { search: { provider: undefined } } },
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

  it.each([
    {
      name: "authenticated direct",
      modelProvider: "openai",
      auth: true,
      suppressManagedWebSearch: undefined,
      native: true,
    },
    {
      name: "unauthenticated direct",
      modelProvider: "openai",
      auth: false,
      suppressManagedWebSearch: undefined,
      native: false,
    },
  ])(
    "selects one Codex search route for $name",
    ({ modelProvider, auth, suppressManagedWebSearch, native }) => {
      const filtered = selectedTools(baseTools, {
        config: {
          tools: {
            web: { search: { enabled: true, openaiCodex: { enabled: true, mode: "cached" } } },
          },
          ...(auth
            ? { auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } } }
            : {}),
        },
        modelProvider,
        suppressManagedWebSearch,
        modelApi: "openai-chatgpt-responses",
        modelId: "gpt-5.4",
      });
      expect(toolNames(filtered)).toEqual(
        native ? ["read", "exec"] : ["read", "web_search", "exec"],
      );
    },
  );

  it("applies inherited lean mode to the session agent", () => {
    const filtered = selectedTools(["read", "browser", "automations", "message", "exec"], {
      config: {
        agents: {
          defaults: { experimental: { localModelLean: true } },
          entries: { main: { experimental: { localModelLean: false } }, gemma: {} },
        },
      },
      sessionKey: "agent:gemma:main",
      modelProvider: "lmstudio",
      modelApi: "openai-compatible",
      modelId: "gemma-4-e4b-it",
    });

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("lets a current agent disable inherited lean local-model mode", () => {
    const filtered = selectedTools(["read", "browser", "automations", "message", "exec"], {
      config: {
        agents: {
          defaults: {
            experimental: {
              localModelLean: true,
            },
          },
          entries: {
            main: {
              experimental: {
                localModelLean: false,
              },
            },
          },
        },
      },
      agentId: "main",
      modelProvider: "openai",
      modelApi: "openai-responses",
      modelId: "gpt-5.4",
    });

    expect(toolNames(filtered)).toEqual(["read", "browser", "automations", "message", "exec"]);
  });
});
