import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import type { StreamFn } from "../runtime/index.js";

const sent: unknown[] = [];
const transport: StreamFn = async (model, _context, options) => {
  sent.push(await options?.onPayload?.({ input: "API_TOKEN=fixture-value" }, model));
  return undefined as never;
};

vi.mock("./stream-resolution.js", () => ({
  resolveEmbeddedAgentApiKey: async () => undefined,
  resolveEmbeddedAgentBaseStreamFn: () => transport,
  resolveEmbeddedAgentStream: () => ({ streamFn: transport }),
}));
vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderTextTransforms: () => undefined,
}));
vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  getModelProviderRuntimePluginHandle: () => undefined,
}));
// Provider/config payload shaping wraps the gate, as on a turn, so the gate sees its output.
vi.mock("./extra-params.js", () => ({
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

const { prepareCompactionSessionAgent } = await import("./compaction-session-agent.js");

afterEach(() => {
  resetGlobalHookRunner();
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
  await prepareCompactionSessionAgent({
    session,
    llmRuntime: {} as never,
    providerStreamFn: undefined,
    sessionId: "fixture-session-id",
    effectiveModel: model as never,
    authStorage: undefined as never,
    provider: "fixture",
    modelId: "fixture",
    thinkLevel: "off",
    sessionAgentId: "main",
    effectiveWorkspace: "/fixture",
    agentDir: "/fixture/agent",
    contextTokenBudget: 32_768,
    modelRequestHookContext: { agentId: "main", sessionKey: "fixture-session" },
  });
  return session.agent.streamFn!;
}

it("gates compaction summary requests with the final shaped payload", async () => {
  const seen: unknown[] = [];
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_model_request",
        handler: async (raw, ctx) => {
          const event = raw as { requestKind: string; payload: { input: string } };
          seen.push({ kind: event.requestKind, payload: event.payload, ctx });
          return { payload: { ...event.payload, input: "API_TOKEN=[REDACTED]" } };
        },
      },
    ]),
  );
  const streamFn = await prepare();
  await streamFn(model, { messages: [] }, {});
  expect(seen).toEqual([
    {
      kind: "compaction",
      payload: { input: "API_TOKEN=fixture-value", shaped: true },
      ctx: expect.objectContaining({ sessionKey: "fixture-session" }),
    },
  ]);
  expect(sent).toEqual([{ input: "API_TOKEN=[REDACTED]", shaped: true }]);
});

it("sends compaction requests unchanged without a plugin", async () => {
  const streamFn = await prepare();
  await streamFn(model, { messages: [] }, {});
  expect(sent).toEqual([{ input: "API_TOKEN=fixture-value", shaped: true }]);
});
