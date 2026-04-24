import { describe, expect, it, vi } from "vitest";
import {
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
  createPermissiveTool,
  createStrictCompatibleTool,
  normalizedParameterFreeSchema,
} from "../../test/helpers/agents/schema-normalization-runtime-contract.js";
import { buildOpenAIResponsesParams } from "./openai-transport-stream.js";
import { convertTools as convertWebSocketTools } from "./openai-ws-message-conversion.js";

describe("OpenAI transport schema normalization runtime contract", () => {
  const buildResponsesParams = vi.fn(buildOpenAIResponsesParams);
  const convertWsTools = vi.fn(convertWebSocketTools);

  it("keeps HTTP Responses and WebSocket strict decisions aligned for the same tool set", () => {
    const tools = [createStrictCompatibleTool(), createPermissiveTool()] as never;
    const httpParams = buildResponsesParams(
      createNativeOpenAIResponsesModel() as never,
      { systemPrompt: "system", messages: [], tools } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: unknown }> };
    const wsTools = convertWsTools(tools, { strict: true });

    expect(httpParams.tools?.map((tool) => tool.strict)).toEqual([false, false]);
    expect(wsTools.map((tool) => tool.strict)).toEqual([false, false]);
  });

  it("documents the current HTTP/WS parameter-free schema normalization gap", () => {
    const tools = [createParameterFreeTool()] as never;
    const httpParams = buildResponsesParams(
      createNativeOpenAIResponsesModel() as never,
      { systemPrompt: "system", messages: [], tools } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: unknown }> };
    const wsTools = convertWsTools(tools, { strict: true });
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
});
