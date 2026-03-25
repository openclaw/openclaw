import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { applyExtraParamsToAgent } from "./extra-params.js";

export type ExtraParamsCapture<TPayload extends Record<string, unknown>> = {
  headers?: Record<string, string>;
  payload: TPayload;
};

type RunExtraParamsCaseParams<
  TApi extends "openai-completions" | "openai-responses",
  TPayload extends Record<string, unknown>,
> = {
  applyModelId?: string;
  applyProvider?: string;
  callerHeaders?: Record<string, string>;
  cfg?: OpenClawConfig;
  model: Model<TApi>;
  options?: SimpleStreamOptions;
  payload: TPayload;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
};

export function runExtraParamsCase<
  TApi extends "openai-completions" | "openai-responses",
  TPayload extends Record<string, unknown>,
>(params: RunExtraParamsCaseParams<TApi, TPayload>): ExtraParamsCapture<TPayload> {
  const captured: ExtraParamsCapture<TPayload> = {
    payload: params.payload,
  };

  const baseStreamFn: StreamFn = (model, _context, options) => {
    captured.headers = options?.headers;
    options?.onPayload?.(params.payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(
    agent,
    params.cfg,
    params.applyProvider ?? params.model.provider,
    params.applyModelId ?? params.model.id,
    undefined,
    params.thinkingLevel,
  );

  const context: Context = { messages: [] };
  void agent.streamFn?.(params.model, context, {
    ...params.options,
    headers: params.callerHeaders ?? params.options?.headers,
  });

  return captured;
}
