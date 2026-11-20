import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model, SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import { buildOpenAIProvider } from "../openai-provider.js";

export function createOpenAIResponsesTestModel() {
  return {
    api: "openai-responses",
    provider: "openai",
    id: "gpt-5.4",
    baseUrl: "https://api.openai.com/v1",
  } as Model<"openai-responses">;
}

export async function runWrappedPayloadCase(params: {
  model?:
    | Model<"openai-responses">
    | Model<"openai-chatgpt-responses">
    | Model<"azure-openai-responses">;
  extraParams?: Record<string, unknown>;
  cfg?: Record<string, unknown>;
  agentId?: string;
  nativeWebSearchAllowedByToolPolicy?: boolean;
  payload?: Record<string, unknown>;
  context?: Context;
  streamOptions?: SimpleStreamOptions & {
    openclawCodeModeToolSurface?: boolean;
    openclawCodeModeAllowedHostedToolTypes?: Set<string>;
  };
}) {
  const payload = params.payload ?? { store: false };
  let capturedOptions: SimpleStreamOptions | undefined;
  const baseStreamFn: StreamFn = (model, _context, options) => {
    capturedOptions = options;
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };

  const wrap = expectDefined(buildOpenAIProvider().wrapStreamFn, "OpenAI wrapper");
  const streamFn = wrap({
    provider: "openai",
    modelId: "gpt-5.4",
    extraParams: params.extraParams,
    config: params.cfg as never,
    agentDir: "/tmp/openai-provider-test",
    agentId: params.agentId,
    nativeWebSearchAllowedByToolPolicy: params.nativeWebSearchAllowedByToolPolicy,
    streamFn: baseStreamFn,
  } as never);

  await streamFn?.(
    params.model ?? createOpenAIResponsesTestModel(),
    params.context ?? { messages: [] },
    params.streamOptions ?? {},
  );

  return {
    payload,
    options: capturedOptions,
  };
}
