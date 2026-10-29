import { isDeepStrictEqual } from "node:util";
import {
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionBatchResultV2,
} from "openclaw/plugin-sdk/decisions";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const MODEL_IDS = ["clef", "clef-flash", "clef-omni"] as const;

export function toWire(batch: DecisionBatchV2, model: string) {
  if (
    !MODEL_IDS.some((id) => id === model) ||
    Object.keys(batch.questions).length > 64 ||
    batch.state.type === "list" ||
    (batch.state.type === "json" &&
      batch.state.value !== null &&
      typeof batch.state.value !== "object" &&
      typeof batch.state.value !== "string")
  ) {
    return undefined;
  }
  for (const [id, q] of Object.entries(batch.questions)) {
    if (
      !/^[A-Za-z0-9_.-]{1,100}$/.test(id) ||
      q.type === "sort" ||
      q.type === "tags" ||
      (q.type === "choice" && Object.keys(q.criteria).length > 255) ||
      (q.type === "score" && q.criteria.length > 10)
    ) {
      return undefined;
    }
  }
  return {
    model,
    state:
      batch.state.type === "text"
        ? batch.state.text
        : batch.state.type === "json"
          ? batch.state.value
          : (batch.state.text ?? ""),
    ...(batch.state.type === "image" ? { images: [batch.state.dataUri] } : {}),
    questions: Object.fromEntries(
      Object.entries(batch.questions).map(([id, q]) => [
        id,
        { ...q, type: q.type === "boolean" ? "noul" : q.type },
      ]),
    ),
  };
}

export function fromWire(
  raw: unknown,
  batch: DecisionBatchV2,
  model: string,
): DecisionBatchResultV2 | undefined {
  const envelope = asOptionalRecord(raw);
  // The CLI may unwrap Cloudflare's success envelope. Explicit API failures
  // must never be interpreted as a successful unwrapped result.
  const value =
    envelope && Object.hasOwn(envelope, "success")
      ? envelope.success === true
        ? asOptionalRecord(envelope.result)
        : undefined
      : envelope;
  const wireAnswers = asOptionalRecord(value?.answers);
  if (
    !value ||
    value.model !== model ||
    !wireAnswers ||
    Object.keys(wireAnswers).length !== Object.keys(batch.questions).length
  ) {
    return undefined;
  }
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(batch.questions)) {
    if (!Object.hasOwn(wireAnswers, id)) {
      return undefined;
    }
    const a = asOptionalRecord(wireAnswers[id]);
    if (!a || a.type !== (q.type === "boolean" ? "noul" : q.type)) {
      return undefined;
    }
    if (q.type === "boolean") {
      Object.defineProperty(answers, id, {
        value: { type: "boolean", probabilityTrue: a.noul },
        enumerable: true,
      });
      continue;
    }
    if (q.type !== "choice" && q.type !== "score") {
      return undefined;
    }
    const probabilities = asOptionalRecord(a.probabilities);
    const labels =
      q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    if (
      !probabilities ||
      Object.keys(probabilities).length !== labels.length ||
      !labels.every((label) => Object.hasOwn(probabilities, label)) ||
      !Object.values(probabilities).some((p) => typeof p === "number" && p > 0) ||
      (q.type === "choice" &&
        (typeof a.choice !== "string" || !Object.hasOwn(q.criteria, a.choice))) ||
      (a.confidence !== undefined &&
        (typeof a.confidence !== "number" ||
          !Number.isFinite(a.confidence) ||
          a.confidence < 0 ||
          a.confidence > 1))
    ) {
      return undefined;
    }
    const confidence = a.confidence === undefined ? {} : { confidence: a.confidence };
    if (q.type === "score") {
      const legend = asOptionalRecord(a.legend);
      if (
        !legend ||
        Object.keys(legend).length !== labels.length ||
        labels.some(
          (key, i) => !Object.hasOwn(legend, key) || !isDeepStrictEqual(legend[key], q.criteria[i]),
        )
      ) {
        return undefined;
      }
    }
    Object.defineProperty(answers, id, {
      enumerable: true,
      value:
        q.type === "choice"
          ? { type: "choice", choice: a.choice, probabilities, ...confidence }
          : {
              type: "score",
              score: a.score,
              probabilities: labels.map((key) => probabilities[key]),
              ...confidence,
            },
    });
  }
  const usage = asOptionalRecord(value.usage);
  if (
    value.usage !== undefined &&
    (!usage ||
      [usage.input_tokens, usage.output_tokens].some(
        (n) => n !== undefined && (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0),
      ))
  ) {
    return undefined;
  }
  const result = {
    model: value.model,
    answers,
    ...(usage
      ? {
          usage: {
            ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
            ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
          },
        }
      : {}),
  };
  return validateDecisionResultV2(batch, result) ? result : undefined;
}
