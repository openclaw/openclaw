import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { assert, expect, it } from "vitest";
import { applyModelDefaults } from "../config/defaults.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import "./ai-transport-runtime-host.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { resolveEmbeddedAgentStream } from "./embedded-agent-runner/stream-resolution.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { ModelRegistry } from "./sessions/model-registry.js";

// Protect config -> runtime model -> serialized SDK request composition, not just the cap helper.
// Only external I/O is replaced; this does not qualify a live server or a full agent turn.
it.each([
  { label: "unknown output limit at 128K", contextWindow: 131_072, expected: 32_768 },
  { label: "served 32K window", contextWindow: 32_768, expected: 16_384 },
  { label: "explicit model cap", contextWindow: 131_072, modelCap: 6_144, expected: 6_144 },
  { label: "explicit provider cap", contextWindow: 131_072, providerCap: 12_288, expected: 12_288 },
  {
    label: "per-request override",
    contextWindow: 131_072,
    modelCap: 6_144,
    providerCap: 12_288,
    requestCap: 2_048,
    expected: 2_048,
  },
])("preserves $label through the actual outbound request", async (scenario) => {
  const provider = "budget-fixture";
  const id = "unknown-chat";
  const parsed = validateConfigObjectRaw({
    plugins: { enabled: false },
    models: {
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl: "https://budget-fixture.invalid/v1",
          apiKey: "synthetic-budget-key",
          ...(scenario.providerCap ? { maxTokens: scenario.providerCap } : {}),
          models: [
            {
              id,
              name: "Budget fixture",
              contextWindow: scenario.contextWindow,
              ...(scenario.modelCap ? { maxTokens: scenario.modelCap } : {}),
              compat: { maxTokensField: "max_tokens" },
            },
          ],
        },
      },
    },
  });
  assert(parsed.ok, JSON.stringify(parsed));
  const cfg = applyModelDefaults(parsed.config, { manifestRegistry: { plugins: [] } });
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = ModelRegistry.fromCapturedSources(authStorage, "unused-models.json", {
    config: cfg,
    modelsJsonContents: null,
    pluginCatalogs: [],
    includePluginCatalogs: false,
  });
  const resolved = await resolveModelAsync(provider, id, undefined, cfg, {
    authStorage,
    modelRegistry,
  });
  assert(resolved.model, resolved.error);
  expect(resolved.model.contextWindow).toBe(scenario.contextWindow);
  const previousHost = getAiTransportHost();
  const requests: Request[] = [];
  const bodies: unknown[] = [];
  configureAiTransportHost({
    ...previousHost,
    // Existing transport-host port: capture the SDK's serialized Request at external I/O.
    // Replaces guarded network I/O only: no proof of SSRF/proxy/TLS or live-auth enforcement.
    buildModelFetch: () => async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      bodies.push(JSON.parse(await request.text()));
      return new Response(
        'data: {"id":"budget","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"budget verified"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const { streamFn } = resolveEmbeddedAgentStream({
      llmRuntime: defaultLlmRuntime,
      currentStreamFn: undefined,
      sessionId: "budget-fixture-session",
      model: resolved.model,
      resolvedApiKey: "synthetic-budget-key",
    });
    const stream = await streamFn(
      resolved.model,
      { messages: [{ role: "user", content: "Verify output budget.", timestamp: 1 }] },
      scenario.requestCap ? { maxTokens: scenario.requestCap } : {},
    );
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "budget verified" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://budget-fixture.invalid/v1/chat/completions");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer synthetic-budget-key");
    expect(bodies).toEqual([
      expect.objectContaining({ model: id, stream: true, max_tokens: scenario.expected }),
    ]);
  } finally {
    configureAiTransportHost(previousHost);
  }
});
