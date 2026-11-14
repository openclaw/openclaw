import {
  encodeSystemOneQuestions,
  type DecisionProviderContextV2,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { evaluateDecisionHttp } from "openclaw/plugin-sdk/decisions-http-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  HOSTED_ORIGIN,
  providerBaseUrl,
  usesHostedEndpoint,
  type RuntimeConfig,
} from "./config.js";
import {
  decodeTypeSafeDecisionResult,
  encodeTypeSafeLocalInput,
  restoreTypeSafeLocalLegends,
  type TypeSafeDecisionBatch,
} from "./decision-codec.js";
import {
  MAX_IMAGE_REQUEST_BYTES,
  MAX_JSON_BYTES,
  parseInput,
  parseResult,
  type EvaluationInput,
  type ImageAssets,
} from "./schema.js";

const IMAGE_OPT_IN_HEADER = "TypeSafe-Danger-Zone-Images";
const API_BASE_URL = `${HOSTED_ORIGIN}/v1`;
const unsupported = { status: "unavailable", reason: "unsupported-input" } as const;

/** Evaluate explicit state without ambient credentials, retries, or vendor diagnostics. */
export async function evaluateTypeSafeDecision(
  batch: TypeSafeDecisionBatch,
  assets: ImageAssets | undefined,
  context: DecisionProviderContextV2,
  config: RuntimeConfig,
): Promise<ProviderDecisionOutcomeV2> {
  const model = context.model.id;
  const hosted = usesHostedEndpoint(config);
  // Kev requires a local System One server.
  if (model === "kev-latest" && hosted) {
    return unsupported;
  }
  let parsed: EvaluationInput;
  let baseUrl: string;
  try {
    parsed = parseInput({
      state: batch.state.type === "text" ? batch.state.text : batch.state.value,
      questions: encodeSystemOneQuestions(batch),
      model,
    });
    baseUrl = config.providerConfig
      ? providerBaseUrl(context.model.baseUrl ?? config.providerConfig.baseUrl)
      : config.baseUrl
        ? `${config.baseUrl}/v1`
        : API_BASE_URL;
  } catch {
    return unsupported;
  }
  const local = !assets && !hosted;
  const wireInput = local ? encodeTypeSafeLocalInput(parsed) : parsed;
  const body = JSON.stringify({ ...wireInput, model, ...(assets ? { assets } : {}) });
  if (
    (assets && baseUrl !== API_BASE_URL) ||
    Buffer.byteLength(body) > (assets ? MAX_IMAGE_REQUEST_BYTES : MAX_JSON_BYTES)
  ) {
    return unsupported;
  }
  // Legacy loopback config never uses the hosted plugin key.
  const sendsCredential =
    (!config.baseUrl || Boolean(config.providerConfig)) &&
    config.providerConfig?.authHeader !== false;
  return evaluateDecisionHttp(
    {
      ...context,
      deadlineMonotonicMs: Math.min(
        context.deadlineMonotonicMs,
        performance.now() + config.timeoutMs,
      ),
    },
    {
      provider: "typesafe",
      baseUrl,
      endpointPath: "systemone",
      body,
      // The opt-in describes this request body, not a persistent provider setting.
      requestHeaders: { [IMAGE_OPT_IN_HEADER]: assets ? "true" : null },
      // The synthetic local marker is no-auth evidence, never a bearer credential.
      authHeaders: (apiKey): Record<string, string> =>
        sendsCredential && apiKey !== "typesafe-local" ? { Authorization: `Bearer ${apiKey}` } : {},
      maxResponseBytes: MAX_JSON_BYTES,
      decode: (payload) => {
        let value = payload;
        if (local) {
          if (!isRecord(value)) {
            throw new Error("Invalid local System One response.");
          }
          if ("latency_ms" in value) {
            const { latency_ms, ...rest } = value;
            if (typeof latency_ms !== "number" || !Number.isFinite(latency_ms) || latency_ms < 0) {
              throw new Error("Invalid local System One latency metadata.");
            }
            value = rest;
          }
        }
        const evaluation = parseResult(value, wireInput);
        if (local) {
          restoreTypeSafeLocalLegends(evaluation, parsed);
        }
        const result = decodeTypeSafeDecisionResult(batch, evaluation);
        return result
          ? { status: "ok", result }
          : { status: "unavailable", reason: "invalid-response" };
      },
    },
  );
}
