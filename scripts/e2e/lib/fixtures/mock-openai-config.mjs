// Mock OpenAI model config helpers for E2E fixture generation.
function formatMockPortValue(value) {
  return value === undefined ? "<missing>" : JSON.stringify(String(value));
}

export function parseMockOpenAiPort(value, label = "mock OpenAI port") {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/u.test(text)) {
    throw new Error(
      `${label} must be a TCP port from 1 to 65535. Got: ${formatMockPortValue(value)}`,
    );
  }
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new Error(
      `${label} must be a TCP port from 1 to 65535. Got: ${formatMockPortValue(value)}`,
    );
  }
  return port;
}

export function applyMockOpenAiModelConfig(cfg, params) {
  const mockPort = parseMockOpenAiPort(params.mockPort);
  const modelRef = params.modelRef ?? "openai/gpt-5.6-luna";
  const modelRefs = [...new Set([modelRef, params.utilityModelRef].filter(Boolean))];
  const configureModels = (models) => ({
    ...models,
    ...Object.fromEntries(
      modelRefs.map((ref) => [
        ref,
        {
          ...models?.[ref],
          agentRuntime: { id: "openclaw" },
          params: { ...models?.[ref]?.params, transport: "sse", openaiWsWarmup: false },
        },
      ]),
    ),
  });
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  cfg.models = {
    ...cfg.models,
    mode: "merge",
    providers: {
      ...cfg.models?.providers,
      openai: {
        ...cfg.models?.providers?.openai,
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        api: "openai-responses",
        agentRuntime: { id: "openclaw" },
        request: { ...cfg.models?.providers?.openai?.request, allowPrivateNetwork: true },
        models: modelRefs.map((ref) => ({
          id: ref.split("/").at(-1),
          name: ref.split("/").at(-1),
          api: "openai-responses",
          agentRuntime: { id: "openclaw" },
          reasoning: false,
          input: ["text", "image"],
          cost,
          contextWindow: 128000,
          contextTokens: 96000,
          maxTokens: 4096,
        })),
      },
    },
  };
  cfg.agents = {
    ...cfg.agents,
    defaults: {
      ...cfg.agents?.defaults,
      model: { primary: modelRef },
      ...(params.utilityModelRef ? { utilityModel: params.utilityModelRef } : {}),
      ...(params.includeImageDefaults
        ? {
            imageModel: { primary: modelRef, timeoutMs: 30_000 },
            mediaModels: {
              ...cfg.agents?.defaults?.mediaModels,
              image: { primary: "openai/gpt-image-1", timeoutMs: 30_000 },
            },
          }
        : {}),
      models: configureModels(cfg.agents?.defaults?.models),
    },
    ...(cfg.agents?.entries
      ? {
          entries: Object.fromEntries(
            Object.entries(cfg.agents.entries).map(([agentId, agent]) => [
              agentId,
              {
                ...agent,
                model: {
                  ...(typeof agent.model === "object" && agent.model !== null ? agent.model : {}),
                  primary: modelRef,
                },
                ...(params.utilityModelRef ? { utilityModel: params.utilityModelRef } : {}),
                models: configureModels(agent.models),
              },
            ]),
          ),
        }
      : {}),
  };
  cfg.plugins = {
    ...cfg.plugins,
    enabled: true,
  };
}
