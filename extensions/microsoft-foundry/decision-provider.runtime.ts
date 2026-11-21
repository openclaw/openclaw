import {
  decodeSystemOneResponse,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionEntry,
  type DecisionProviderContextV2,
  type ProviderDecisionOutcomeV2,
  type ProviderFailureReason,
} from "openclaw/plugin-sdk/decisions";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { FoundryDecisionRoute } from "./decision-provider.js";

const MAX_BYTES = 1_048_576;

function unavailable(reason: ProviderFailureReason): ProviderDecisionOutcomeV2 {
  return { status: "unavailable", reason };
}

function text(value: DecisionEntry): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function encodeRequest(batch: DecisionBatchV2, deployment: string): string | undefined {
  if (batch.state.type !== "text" && batch.state.type !== "json") {
    return undefined;
  }
  const entries = [];
  for (const [id, q] of Object.entries(batch.questions)) {
    const instructions = q.instructions == null ? undefined : text(q.instructions);
    if (q.type === "score") {
      entries.push([id, { type: "score", instructions, criteria: q.criteria.map(text) }]);
    } else if (q.type === "choice" || q.type === "boolean") {
      const criteria =
        q.criteria == null
          ? undefined
          : Object.fromEntries(
              Object.entries(q.criteria).map(([label, hint]) => [label, text(hint)]),
            );
      entries.push([
        id,
        { type: q.type === "boolean" ? "noul" : "choice", instructions, criteria },
      ]);
    } else {
      return undefined;
    }
  }
  const body = JSON.stringify({
    model: deployment,
    state: batch.state.type === "text" ? batch.state.text : batch.state.value,
    questions: Object.fromEntries(entries),
  });
  return Buffer.byteLength(body) <= MAX_BYTES ? body : undefined;
}

function decodeResult(batch: DecisionBatchV2, payload: Record<string, unknown>, model: string) {
  const { answers, usage } = payload;
  if (
    payload.error != null ||
    payload.refusal != null ||
    typeof payload.model !== "string" ||
    payload.model.toLowerCase() !== model ||
    !isRecord(answers) ||
    !isRecord(usage)
  ) {
    return undefined;
  }
  for (const [id, q] of Object.entries(batch.questions)) {
    const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
    if (
      !isRecord(answer) ||
      answer.error != null ||
      answer.refusal != null ||
      answer.type === "refusal"
    ) {
      return undefined;
    }
    const legend = answer.legend;
    if (
      q.type === "score" &&
      legend !== undefined &&
      (!isRecord(legend) ||
        Object.keys(legend).length !== q.criteria.length ||
        q.criteria.some((value, index) => legend[String(index)] !== text(value)))
    ) {
      return undefined;
    }
  }
  return decodeSystemOneResponse(
    batch,
    {
      model: payload.model,
      answers,
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    },
    { confidence: "optional" },
  );
}

export async function evaluateFoundryDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
  route: FoundryDecisionRoute,
  matchesLiveRoute: () => boolean,
  model: string,
): Promise<ProviderDecisionOutcomeV2> {
  const apiKey = context.auth.apiKey;
  if (context.auth.mode !== "api-key" || !apiKey) {
    return unavailable("credentials-unavailable");
  }
  if (context.reasoning !== undefined && context.reasoning !== "auto") {
    return unavailable("unsupported-input");
  }
  const body = encodeRequest(batch, route.deployment);
  if (body === undefined) {
    return unavailable("unsupported-input");
  }
  const signal = context.signal;
  const assertAdmitted = () => {
    signal.throwIfAborted();
    if (
      performance.now() >= context.deadlineMonotonicMs ||
      !context.isAdmissible() ||
      !matchesLiveRoute()
    ) {
      throw new Error("Foundry Decision request is no longer admitted.");
    }
  };
  const headers = {
    "api-key": apiKey,
    accept: "application/json",
    "content-type": "application/json",
  };
  try {
    assertAdmitted();
    const { response, release } = await fetchWithSsrFGuard({
      url: `https://${route.host}/providers/microsoft/v1/systemone`,
      requireHttps: true,
      policy: { hostnameAllowlist: [route.host] },
      maxRedirects: 0,
      capture: false,
      signal,
      beforeRequest: assertAdmitted,
      init: { method: "POST", headers, body },
    });
    try {
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return unavailable("authentication");
        }
        if (response.status === 429) {
          return unavailable("rate-limited");
        }
        return unavailable(
          [400, 413, 415, 422].includes(response.status) ? "unsupported-input" : "transport",
        );
      }
      let payload: Record<string, unknown>;
      try {
        payload = await readProviderJsonObjectResponse(response, "Foundry Decision", {
          maxBytes: MAX_BYTES,
          signal,
          requestHeaders: headers,
        });
      } catch {
        signal.throwIfAborted();
        return unavailable("invalid-response");
      }
      assertAdmitted();
      if (JSON.stringify(payload).includes(apiKey)) {
        return unavailable("invalid-response");
      }
      const result = decodeResult(batch, payload, model);
      return validateDecisionResultV2(batch, result, context.model.inference?.decision)
        ? { status: "ok", result }
        : unavailable("invalid-response");
    } finally {
      await release();
    }
  } catch {
    signal.throwIfAborted();
    return unavailable("transport");
  }
}
