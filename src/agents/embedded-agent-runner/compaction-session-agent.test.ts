import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import { buildAgentRuntimePlan } from "../runtime-plan/build.js";
import type { StreamFn } from "../runtime/index.js";
import { AuthStorage } from "../sessions/auth-storage.core.js";
import { ModelRegistry } from "../sessions/model-registry.core.js";
import { SettingsManager } from "../sessions/settings-manager.js";

const sent: unknown[] = [];
const transport: StreamFn = async (model, _context, options) => {
  sent.push(await options?.onPayload?.({ input: "API_TOKEN=fixture-value" }, model));
  return undefined as never;
};

vi.mock("./stream-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stream-resolution.js")>()),
  resolveEmbeddedAgentApiKey: async () => undefined,
  resolveEmbeddedAgentBaseStreamFn: () => transport,
  resolveEmbeddedAgentStream: () => ({ streamFn: transport }),
}));
vi.mock("../../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-runtime.js")>()),
  resolveProviderTextTransforms: () => undefined,
}));
vi.mock("../../plugins/provider-hook-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-hook-runtime.js")>()),
  getModelProviderRuntimePluginHandle: () => undefined,
}));
// Preserve provider/config payload shaping when preparing the summary transport.
vi.mock("./extra-params.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./extra-params.js")>()),
  applyExtraParamsToAgent: (agent: { streamFn: StreamFn }) => {
    const inner = agent.streamFn;
    agent.streamFn = (model, context, options) =>
      inner(model, context, {
        ...options,
        onPayload: async (payload, payloadModel) => ({
          ...(payload as object),
          shaped: true,
          ...((await options?.onPayload?.(payload, payloadModel)) as object | undefined),
        }),
      });
    return {};
  },
}));

const { prepareCompactionSessionStream } = await import("./compaction-session-agent.js");

afterEach(() => {
  sent.length = 0;
});

const model = {
  id: "fixture",
  provider: "fixture",
  api: "openai-responses",
  baseUrl: "https://fixture.invalid",
} as Model;

async function prepare() {
  const session = { agent: {} as { streamFn?: StreamFn } };
  const authStorage = AuthStorage.inMemory();
  await prepareCompactionSessionStream(
    {
      effectiveModel: model,
      authStorage,
      provider: "fixture",
      modelId: "fixture",
      sessionAgentId: "main",
      effectiveWorkspace: "/fixture",
      agentDir: "/fixture/agent",
      contextTokenBudget: 32_768,
      runtimePlan: buildAgentRuntimePlan({
        provider: "fixture",
        modelId: "fixture",
        model,
        workspaceDir: "/fixture",
      }),
      resolvedMessageProvider: undefined,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      hasRuntimeAuthExchange: false,
      apiKeyInfo: { source: "fixture", mode: "api-key" },
      params: { sessionId: "fixture-session-id", sessionKey: "fixture-session" },
      trigger: "manual",
    },
    SettingsManager.inMemory(),
    () => {},
    "off",
    undefined,
    session,
  );
  return session.agent.streamFn!;
}

it("sends compaction requests unchanged without a plugin", async () => {
  const streamFn = await prepare();
  await streamFn(model, { messages: [] }, {});
  expect(sent).toEqual([{ input: "API_TOKEN=fixture-value", shaped: true }]);
});
