import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentsApiConfig } from "./config.js";
import plugin from "./index.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

beforeEach(() => {
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
});

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

it.each(["dedicated", "legacy"] as const)(
  "authenticates registered isolated completions with the %s key",
  async (mode) => {
    const pluginConfig = mode === "dedicated" ? { apiKey: "fixture-agents-api-key" } : {};
    const { harness, config } = registerHarness(pluginConfig);
    const params = createIsolatedParams(config);
    if (mode === "dedicated" && params.authorization.owner === "host") {
      params.authorization = {
        owner: "harness",
        model: {
          ...params.authorization.model,
          api: "openai-chatgpt-responses",
          baseUrl: "https://responses.example.test/v1",
        },
        plan: {
          providerForAuth: "openai",
          modelId: params.modelId,
          authProfileProviderForAuth: "openai",
          harnessAuthProvider: "agentsapi",
          credentialSource: { kind: "none" },
        },
        authProfileStore: { version: 1, profiles: {} },
      };
      expect(
        harness.supports({
          provider: "openai",
          requestedRuntime: "agentsapi",
          modelProvider: {
            api: "openai-chatgpt-responses",
            baseUrl: "https://responses.example.test/v1",
            preparedAuth: { source: "profile", mode: "oauth", requirement: "subscription" },
          },
        }),
      ).toEqual({ supported: true });
    }
    const backendMessage = "Fixture isolated session creation rejected";
    fetchWithSsrFGuardMock.mockImplementation(async (request) => {
      request.beforeRequest?.();
      return {
        response: Response.json({ error: { message: backendMessage } }, { status: 400 }),
        finalUrl: request.url,
        release: async () => {},
      };
    });
    try {
      await expect(harness.runIsolatedCompletionV2(params)).rejects.toThrow(backendMessage);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
      const call = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
      if (!call) {
        throw new Error("Expected an SDK isolated session creation request");
      }
      const request = new Request(call.url, call.init);
      expect(request.url).toBe("https://api.openai.com/v1/agents/sessions");
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${mode === "dedicated" ? "fixture-agents-api-key" : "fixture-provider-key"}`,
      );
      expect(await request.json()).toMatchObject({
        agent: { model: params.modelId },
        environment: { type: "none" },
      });
    } finally {
      await harness.dispose?.();
    }
  },
);

it.each([
  { name: "missing", value: undefined },
  { name: "empty", value: " " },
  { name: "unresolved environment placeholder", value: "${AGENTS_API_KEY}" },
  {
    name: "unresolved SecretRef",
    value: { source: "env", provider: "default", id: "AGENTS_API_KEY" },
  },
])("rejects a $name configured key despite available provider auth", async ({ value }) => {
  const { harness } = registerHarness({ apiKey: "fixture-agents-api-key" });
  const params = createIsolatedParams({
    plugins: { entries: { agentsapi: { config: { apiKey: value } } } },
  });
  try {
    await expect(async () => harness.runIsolatedCompletionV2(params)).rejects.toThrow(
      "plugins.entries.agentsapi.config.apiKey",
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(0);
  } finally {
    await harness.dispose?.();
  }
});

function registerHarness(pluginConfig: AgentsApiConfig) {
  const config: OpenClawConfig = {
    plugins: { entries: { agentsapi: { config: pluginConfig } } },
  };
  const runtime = createPluginRuntimeMock({ config: { current: () => config } });
  const registerAgentHarness = vi.fn<OpenClawPluginApi["registerAgentHarness"]>();
  plugin.register(
    createTestPluginApi({ id: "agentsapi", runtime, pluginConfig, registerAgentHarness }),
  );
  const harness = registerAgentHarness.mock.calls[0]?.[0];
  if (!harness?.runIsolatedCompletionV2) {
    throw new Error("Expected the registered Agents API isolated completion handler");
  }
  return {
    harness: { ...harness, runIsolatedCompletionV2: harness.runIsolatedCompletionV2.bind(harness) },
    config,
  };
}

function createIsolatedParams(
  config: OpenClawConfig,
): Parameters<NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>>[0] {
  return {
    config,
    provider: "openai",
    modelId: "fixture-model",
    authorization: {
      owner: "host",
      auth: { mode: "api-key", apiKey: "fixture-provider-key", source: "fixture" },
      model: {
        id: "fixture-model",
        name: "Fixture model",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens: 512,
      },
    },
    agentId: "main",
    agentDir: "/fixture/agent",
    workspaceDir: "/fixture/workspace",
    systemPrompt: "Fixture instructions",
    prompt: "Fixture prompt",
    timeoutMs: 5_000,
  };
}
