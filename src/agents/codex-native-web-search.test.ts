import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ToolsSchema } from "../config/zod-schema.agent-runtime.js";
import {
  patchCodexNativeWebSearchPayload,
  resolveCodexNativeSearchActivation,
} from "./codex-native-web-search-core.js";
import { isCodexNativeWebSearchRelevant } from "./codex-native-web-search.js";
import {
  describeCodexNativeWebSearch,
  resolveCodexNativeWebSearchConfig,
} from "./codex-native-web-search.shared.js";

type SearchConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"];
const searchConfig = (search: SearchConfig): OpenClawConfig => ({ tools: { web: { search } } });
const baseConfig = searchConfig({ enabled: true, openaiCodex: { enabled: true, mode: "cached" } });
function activate(params: Parameters<typeof resolveCodexNativeSearchActivation>[0] = {}) {
  return resolveCodexNativeSearchActivation({
    config: baseConfig,
    modelProvider: "gateway",
    modelApi: "openai-chatgpt-responses",
    ...params,
  });
}
describe("resolveCodexNativeSearchActivation", () => {
  it.each<[string, Parameters<typeof activate>[0], string]>([
    [
      "native search disabled",
      { config: searchConfig({ enabled: true }), modelProvider: "openai" },
      "codex_not_enabled",
    ],
    [
      "explicit managed provider",
      { config: searchConfig({ provider: "brave", openaiCodex: { enabled: true } }) },
      "managed_provider_selected",
    ],
    [
      "ineligible model",
      { modelProvider: "openai", modelApi: "openai-responses" },
      "model_not_eligible",
    ],
    [
      "global disable",
      {
        config: searchConfig({ enabled: false, openaiCodex: { enabled: true, mode: "live" } }),
        modelProvider: "openai",
      },
      "globally_disabled",
    ],
    ["session disable", { webSearchEnabled: false }, "globally_disabled"],
    [
      "agent policy",
      {
        config: {
          ...baseConfig,
          agents: { entries: { main: { tools: { deny: ["group:web"] } } } },
        },
        sessionKey: "agent:main:main",
        modelId: "gpt-5.5",
      },
      "tool_policy_denied",
    ],
    [
      "sandbox policy",
      { sandboxToolPolicy: { deny: ["group:web"] }, modelId: "gpt-5.5" },
      "tool_policy_denied",
    ],
  ])("keeps native search inactive: %s", (name, params, reason) => {
    expect(activate(params), name).toMatchObject({ state: "managed_only", inactiveReason: reason });
  });

  it("leaves credential admission to the model request for direct openai without auth", () => {
    const result = activate({ config: baseConfig, modelProvider: "openai" });
    expect(result).toMatchObject({ state: "native_active" });
    expect(result).not.toHaveProperty("inactiveReason");
  });
});

describe("Codex native web-search payload helpers", () => {
  it("omits the summary when global web search is disabled", () => {
    expect(
      describeCodexNativeWebSearch(
        searchConfig({ enabled: false, openaiCodex: { enabled: true, mode: "live" } }),
      ),
    ).toBeUndefined();
  });

  it("uses schema-normalized optional config values", () => {
    const tools = ToolsSchema.parse({
      web: {
        search: {
          openaiCodex: {
            enabled: true,
            allowedDomains: [" example.com ", "example.com", ""],
            contextSize: "high",
            userLocation: {
              country: " US ",
              city: " New York ",
              timezone: "America/New_York",
            },
          },
        },
      },
    });
    const result = resolveCodexNativeWebSearchConfig({ tools: { web: tools?.web } });
    expect(result).toMatchObject({
      enabled: true,
      mode: "cached",
      allowedDomains: ["example.com"],
      contextSize: "high",
      userLocation: { country: "US", city: "New York", timezone: "America/New_York" },
    });
  });

  it.each([
    {
      name: "live search restrictions",
      payload: {},
      config: searchConfig({
        openaiCodex: {
          enabled: true,
          mode: "live",
          allowedDomains: ["example.com"],
          contextSize: "medium",
          userLocation: { country: "US" },
        },
      }),
      status: "injected",
      tools: [
        {
          type: "web_search",
          external_web_access: true,
          filters: { allowed_domains: ["example.com"] },
          search_context_size: "medium",
          user_location: { type: "approximate", country: "US" },
        },
      ],
    },
    {
      name: "cached search alongside existing functions",
      payload: { tools: [{ type: "function", name: "read" }] },
      config: baseConfig,
      status: "injected",
      tools: [
        { type: "function", name: "read" },
        { type: "web_search", external_web_access: false },
      ],
    },
    {
      name: "existing native search without duplication",
      payload: { tools: [{ type: "web_search" }] },
      config: baseConfig,
      status: "native_tool_already_present",
      tools: [{ type: "web_search" }],
    },
  ])("projects $name", ({ payload, config, status, tools }) => {
    expect(patchCodexNativeWebSearchPayload({ payload, config }).status).toBe(status);
    expect(payload).toEqual({ tools });
  });
});

it("treats a default model with model-level openai-chatgpt-responses api as relevant", async () => {
  // Provider-level APIs can be generic while individual models opt into the
  // ChatGPT Responses shape that supports native web_search.
  const model: ModelDefinitionConfig = {
    id: "gpt-5.4",
    name: "gpt-5.4",
    api: "openai-chatgpt-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const config: OpenClawConfig = {
    agents: { defaults: { model: { primary: "gateway/gpt-5.4" } } },
    models: {
      providers: {
        gateway: {
          api: "openai-responses",
          baseUrl: "https://gateway.example/v1",
          models: [model],
        },
      },
    },
  };
  expect(await isCodexNativeWebSearchRelevant({ config })).toBe(true);
});
