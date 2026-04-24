import { describe, expect, it } from "vitest";
import {
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
  createPermissiveTool,
  createStrictCompatibleTool,
  normalizedParameterFreeSchema,
} from "../../test/helpers/agents/schema-normalization-runtime-contract.js";
import { buildProviderToolCompatFamilyHooks } from "../plugin-sdk/provider-tools.js";
import { buildOpenAIResponsesParams } from "./openai-transport-stream.js";
import { convertTools as convertWebSocketTools } from "./openai-ws-message-conversion.js";

describe("OpenAI transport schema normalization runtime contract", () => {
  it("keeps HTTP Responses and WebSocket strict decisions aligned for the same tool set", () => {
    const tools = [createStrictCompatibleTool(), createPermissiveTool()] as never;
    const httpParams = buildOpenAIResponsesParams(
      createNativeOpenAIResponsesModel() as never,
      { systemPrompt: "system", messages: [], tools } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: unknown }> };
    const wsTools = convertWebSocketTools(tools, { strict: true });

    expect(httpParams.tools?.map((tool) => tool.strict)).toEqual([false, false]);
    expect(wsTools.map((tool) => tool.strict)).toEqual([false, false]);
  });

  it("documents the current HTTP/WS parameter-free schema normalization gap", () => {
    const tools = [createParameterFreeTool()] as never;
    const httpParams = buildOpenAIResponsesParams(
      createNativeOpenAIResponsesModel() as never,
      { systemPrompt: "system", messages: [], tools } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: unknown }> };
    const wsTools = convertWebSocketTools(tools, { strict: true });
    const normalizedSchema = normalizedParameterFreeSchema();

    expect(httpParams.tools?.[0]?.strict).toBe(wsTools[0]?.strict);
    expect(httpParams.tools?.[0]?.parameters).toEqual({
      type: normalizedSchema.type,
      properties: normalizedSchema.properties,
    });
    expect(wsTools[0]?.parameters).toEqual({
      type: normalizedSchema.type,
      properties: normalizedSchema.properties,
    });
  });

  it.todo(
    "normalizes parameter-free tool schemas to the same strict-compatible object shape for HTTP Responses and WebSocket",
  );

  it("keeps provider-prepared parameter-free schemas strict-compatible across HTTP Responses and WebSocket", () => {
    const hooks = buildProviderToolCompatFamilyHooks("openai");
    const tools = hooks.normalizeToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      tools: [createParameterFreeTool()] as never,
    }) as never;
    const httpParams = buildOpenAIResponsesParams(
      createNativeOpenAIResponsesModel() as never,
      { systemPrompt: "system", messages: [], tools } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: unknown }> };
    const wsTools = convertWebSocketTools(tools, { strict: true });
    const normalizedSchema = normalizedParameterFreeSchema();

    expect(httpParams.tools?.[0]?.strict).toBe(true);
    expect(wsTools[0]?.strict).toBe(true);
    expect(httpParams.tools?.[0]?.parameters).toEqual(normalizedSchema);
    expect(wsTools[0]?.parameters).toEqual(normalizedSchema);
  });

  it.todo("passes prepared executable schemas through compaction-triggered Responses requests");
});
