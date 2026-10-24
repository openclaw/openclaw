import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
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
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

function selectedTools(
  requestedTools: string[],
  options?: NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>,
) {
  setRuntimeConfigSnapshot(options?.config ?? {});
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

it("keeps web_search for OpenRouter xAI model ids so OpenClaw tool routing stays authoritative", () => {
  const filtered = selectedTools(baseTools, {
    modelCompat: { toolSchemaProfile: "xai", toolCallArgumentsEncoding: "html-entities" },
  });

  expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
});

it.each(["resolved custom endpoint", "disabled plugin"])(
  "uses one search route before tool discovery for OpenAI %s",
  (route) => {
    const customEndpoint = route === "resolved custom endpoint";
    const baseUrl = "https://api.openai.com/v1";
    const filtered = selectedTools(baseTools, {
      config: {
        plugins: customEndpoint ? undefined : { entries: { openai: { enabled: false } } },
        tools: { web: { search: { provider: undefined } } },
        models: { providers: { openai: { api: "openai-responses", baseUrl, models: [] } } },
      },
      modelProvider: "openai",
      modelApi: "openai-responses",
      modelBaseUrl: customEndpoint ? "https://proxy.example/v1" : undefined,
      modelId: "gpt-5.4",
    });

    expect(toolNames(filtered)).toEqual(baseTools);
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: filtered });
    const projection = createCodeModeCatalogProjection(catalogRef.current?.entries ?? []);
    expect(projection.byCallableName.has("web_search")).toBe(true);
  },
);

it.each([true, false])(
  "selects the admitted Codex transport's search route (auth metadata: %s)",
  (auth) => {
    const filtered = selectedTools(baseTools, {
      config: {
        tools: {
          web: { search: { enabled: true, openaiCodex: { enabled: true, mode: "cached" } } },
        },
        ...(auth
          ? { auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } } }
          : {}),
      },
      modelProvider: "openai",
      modelApi: "openai-chatgpt-responses",
      modelId: "gpt-5.4",
    });
    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  },
);
