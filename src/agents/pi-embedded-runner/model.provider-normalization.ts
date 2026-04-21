import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { normalizeModelCompat } from "../../plugins/provider-model-compat.js";
import { ollamaSupportsThinking } from "../../plugins/provider-model-helpers.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

export function normalizeResolvedProviderModel(params: {
  provider: string;
  model: Model<Api>;
}): Model<Api> {
  return normalizeModelCompat(params.model);
}

function isOllamaTarget(params: { provider?: string; api?: unknown }): boolean {
  return normalizeLowercaseStringOrEmpty(params.provider) === "ollama" || params.api === "ollama";
}

export function stripUnsupportedOllamaThinkingPayload(params: {
  provider?: string;
  api?: unknown;
  modelId: string;
  payload: Record<string, unknown>;
}): void {
  if (!isOllamaTarget(params)) {
    return;
  }
  const payloadModelId = typeof params.payload.model === "string" ? params.payload.model : "";
  const modelId = payloadModelId.trim() || params.modelId;
  if (ollamaSupportsThinking(modelId)) {
    return;
  }
  delete params.payload.thinking;
  delete params.payload.reasoning;
  // Ollama's OpenAI-compat endpoint maps reasoning_effort to its internal `think`
  // parameter. When the target model doesn't support thinking, Ollama returns:
  //   400 {"error":"\"<model>\" does not support thinking"}
  // Verified against ollama/v1/chat/completions with llama3.2:3b (2026-04-21).
  delete params.payload.reasoning_effort;
  // OpenClaw's native Ollama adapter (createOllamaThinkingWrapper in
  // src/extensions/ollama/stream.ts) writes `think: true|false` directly into
  // the /api/chat payload whenever ctx.thinkingLevel is set (including "off").
  // Because createOllamaThinkingCompatWrapper wraps OUTSIDE createOllamaThinkingWrapper
  // in createConfiguredOllamaCompatStreamWrapper, this strip runs AFTER the add
  // in the onPayload chain — so deleting `think` here removes it before the
  // request is sent. Without this delete, llama3.2:3b (and any other model
  // where ollamaSupportsThinking() is false) gets rejected by Ollama with
  // 400 {"error":"\"<model>\" does not support thinking"} on /api/chat.
  delete params.payload.think;
  // Qwen / Z.AI style thinking toggles also cause "does not support thinking"
  // rejections on Ollama for models that lack reasoning capability.
  delete params.payload.enable_thinking;
  if (
    params.payload.chat_template_kwargs &&
    typeof params.payload.chat_template_kwargs === "object" &&
    !Array.isArray(params.payload.chat_template_kwargs)
  ) {
    const tmpl = params.payload.chat_template_kwargs as Record<string, unknown>;
    delete tmpl.enable_thinking;
    delete tmpl.preserve_thinking;
    if (Object.keys(tmpl).length === 0) {
      delete params.payload.chat_template_kwargs;
    }
  }
}

export function createOllamaThinkingCompatWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isOllamaTarget({ provider: model.provider, api: model.api })) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      stripUnsupportedOllamaThinkingPayload({
        provider: model.provider,
        api: model.api,
        modelId: model.id,
        payload,
      });
    });
  };
}
