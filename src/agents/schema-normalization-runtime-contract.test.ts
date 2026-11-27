import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createNativeOpenAIResponsesModel as responseModel,
  createParameterFreeTool,
  createPermissiveTool as permissiveTool,
  createStrictCompatibleTool as strictTool,
  normalizedParameterFreeSchema as emptySchema,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { expect, it } from "vitest";
import { createOpenAIResponsesContextManagementWrapper } from "../llm/providers/stream-wrappers/openai.js";
import { buildProviderToolCompatFamilyHooks } from "../plugin-sdk/provider-tools.js";
import { testing as openAITransportTesting } from "./openai-transport-stream.test-support.js";

const { buildOpenAIResponsesParams: buildParams } = openAITransportTesting;

function responseParams(tools: Parameters<typeof buildParams>[1]["tools"]) {
  return buildParams(
    responseModel() as never,
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

it("decides HTTP Responses strict per tool: one permissive tool no longer downgrades the rest", () => {
  const httpParams = responseParams([strictTool(), permissiveTool()] as never);
  expect(httpParams.tools?.map((tool) => tool.strict)).toEqual([true, false]);
});

// A parameter-free tool is not closed as written, so it is sent non-strict and unchanged.
it("keeps raw parameter-free schemas non-strict for HTTP Responses", () => {
  const tool = responseParams([createParameterFreeTool()] as never).tools?.[0];
  expect(tool?.strict).toBe(false);
});

it("passes prepared executable schemas through compaction-triggered Responses requests", () => {
  // Server-side compaction must not strip provider-prepared strict tool schemas.
  const tools = preparedTools() as never;
  const model = responseModel() as never;
  let payload:
    | { context_management?: unknown; tools?: Array<{ parameters?: unknown; strict?: boolean }> }
    | undefined;
  const baseStreamFn: StreamFn = (modelArg, contextArg, optionsArg) => {
    payload = buildParams(modelArg, contextArg, optionsArg as never) as typeof payload;
    optionsArg?.onPayload?.(payload, modelArg);
    return {} as ReturnType<StreamFn>;
  };
  const streamFn = createOpenAIResponsesContextManagementWrapper(baseStreamFn, {
    responsesServerCompaction: true,
  });

  void streamFn(model, { systemPrompt: "system", messages: [], tools } as never, {});

  expect(payload?.context_management).toEqual([{ type: "compaction", compact_threshold: 170_000 }]);
  expect(payload?.tools?.[0]?.strict).toBe(true);
  expect(payload?.tools?.[0]?.parameters).toEqual(emptySchema());
});
