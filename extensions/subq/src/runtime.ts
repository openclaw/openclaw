import type {
  DecisionBatch,
  DecisionProviderV1,
  ProviderDecisionOutcome,
} from "openclaw/plugin-sdk/decisions";
import { executeDecisionHttp } from "openclaw/plugin-sdk/decisions-http-runtime";
import {
  supportsSubQDecisionBatch,
  encodeSubQDecisionRequest,
  decodeSubQDecisionResult,
} from "./decision-codec.js";

// The shared Decision runtime admits at most 1 MiB.
const MAX_BYTES = 1024 * 1024;
type Context = Parameters<DecisionProviderV1["evaluate"]>[1];

export async function evaluate(
  batch: DecisionBatch,
  context: Context,
  apiKey: string,
): Promise<ProviderDecisionOutcome> {
  context.signal.throwIfAborted();
  if (!supportsSubQDecisionBatch(batch, context.model)) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const body = encodeSubQDecisionRequest(batch, context.model);
  if (Buffer.byteLength(body) > MAX_BYTES) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  return executeDecisionHttp<ProviderDecisionOutcome>({
    provider: "subq",
    baseUrl: "https://api.subq.ai/v1",
    endpointPath: "systemone",
    body,
    auth: { mode: "api-key", apiKey },
    signal: context.signal,
    deadlineMonotonicMs: context.deadlineMonotonicMs,
    isAdmissible: context.isAdmissible ?? (() => true),
    decode: (payload) => ({ status: "ok", result: decodeSubQDecisionResult(payload, batch) }),
  });
}
