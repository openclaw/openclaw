import { randomUUID } from "node:crypto";
import type { Model, StreamOptions } from "@openclaw/llm-core";
import { getAiTransportHost } from "../host.js";
import { hasOpencodeSessionHeader, resolveOpencodeSessionHeaders } from "./session-affinity.js";

export function resolveProviderTransportTurnState(
  model: Model,
  params: {
    sessionId?: string;
    turnId: string;
    attempt: number;
    transport: "stream" | "websocket";
  },
) {
  const normalizedProvider = model.provider.trim().toLowerCase();
  const allowRuntimePluginLoad =
    normalizedProvider === "openai" ||
    normalizedProvider === "azure-openai" ||
    normalizedProvider === "azure-openai-responses";
  return getAiTransportHost().plugin.resolveTransportTurnState({
    provider: model.provider,
    modelId: model.id,
    allowRuntimePluginLoad,
    context: {
      provider: model.provider,
      modelId: model.id,
      model,
      sessionId: params.sessionId,
      turnId: params.turnId,
      attempt: params.attempt,
      transport: params.transport,
    },
  });
}

export function filterProviderTurnHeadersForExplicitOpencodeSession(
  model: Pick<Model, "headers">,
  options: Pick<StreamOptions, "headers"> | undefined,
  turnHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!turnHeaders || !hasOpencodeSessionHeader(model, options)) {
    return turnHeaders;
  }
  const filtered = Object.fromEntries(
    Object.entries(turnHeaders).filter(([name]) => name.toLowerCase() !== "x-opencode-session"),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export function resolveProviderSimpleCompletionHeaders(
  model: Model,
  options?: Pick<StreamOptions, "headers" | "sessionId">,
) {
  const optionHeaders = resolveOpencodeSessionHeaders(model, options);
  const turnState = resolveProviderTransportTurnState(model, {
    sessionId: options?.sessionId,
    turnId: randomUUID(),
    attempt: 1,
    transport: "stream",
  });
  const turnHeaders = filterProviderTurnHeadersForExplicitOpencodeSession(
    model,
    { headers: optionHeaders },
    turnState?.headers,
  );
  return { ...turnHeaders, ...optionHeaders };
}
