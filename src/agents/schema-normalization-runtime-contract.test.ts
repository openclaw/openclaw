import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
  createPermissiveTool,
  createStrictCompatibleTool,
  normalizedParameterFreeSchema,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { expect, it } from "vitest";
import { createOpenAIResponsesContextManagementWrapper } from "../llm/providers/stream-wrappers/openai.js";
import { buildProviderToolCompatFamilyHooks } from "../plugin-sdk/provider-tools.js";
import { testing as openAITransportTesting } from "./openai-transport-stream.test-support.js";

const { buildOpenAIResponsesParams } = openAITransportTesting;

function responseParams(tools: Parameters<typeof buildOpenAIResponsesParams>[1]["tools"]) {
  return buildOpenAIResponsesParams(
    createNativeOpenAIResponsesModel() as never,
    { systemPrompt: "system", messages: [], tools },
    undefined,
  ) as { tools?: Array<{ strict?: boolean; parameters?: unknown }> };
}

function preparedTools() {
  return buildProviderToolCompatFamilyHooks("openai").normalizeToolSchemas({
    provider: "openai",
    modelId: "gpt-5.4",
    modelApi: "openai-responses",
    tools: [createParameterFreeTool()] as never,
  });
}

it("keeps HTTP Responses strict decisions stable for the same tool set", () => {
  const httpParams = responseParams([
    createStrictCompatibleTool(),
    createPermissiveTool(),
  ] as never);
  expect(httpParams.tools?.map((tool) => tool.strict)).toEqual([false, false]);
});

it.each([
  ["raw", () => [createParameterFreeTool()]],
  ["provider-prepared", preparedTools],
] as const)("normalizes %s parameter-free schemas for HTTP Responses", (_name, tools) => {
  const tool = responseParams(tools() as never).tools?.[0];
  expect(tool?.strict).toBe(true);
  expect(tool?.parameters).toEqual(normalizedParameterFreeSchema());
});

it("passes prepared executable schemas through compaction-triggered Responses requests", () => {
  // Server-side compaction must not strip provider-prepared strict tool schemas.
  const tools = preparedTools() as never;
  const model = createNativeOpenAIResponsesModel() as never;
  let payload:
    | { context_management?: unknown; tools?: Array<{ parameters?: unknown }> }
    | undefined;
  const baseStreamFn: StreamFn = (modelArg, contextArg, optionsArg) => {
    payload = buildOpenAIResponsesParams(
      modelArg,
      contextArg,
      optionsArg as never,
    ) as typeof payload;
    optionsArg?.onPayload?.(payload, modelArg);
    return {} as ReturnType<StreamFn>;
  };
  const streamFn = createOpenAIResponsesContextManagementWrapper(baseStreamFn, {
    responsesServerCompaction: true,
  });

  void streamFn(model, { systemPrompt: "system", messages: [], tools } as never, {});

  expect(payload?.context_management).toEqual([{ type: "compaction", compact_threshold: 140_000 }]);
  expect(payload?.tools?.[0]?.parameters).toEqual(normalizedParameterFreeSchema());
});
