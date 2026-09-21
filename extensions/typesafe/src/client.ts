import type { RuntimeConfig } from "./config.js";
import { EvaluationError, evaluationError } from "./errors.js";
import { localInput, parseLocalResult } from "./local.js";
import { parseInput, parseResult } from "./schema.js";
import { requestEvaluation } from "./transport.js";

/** Evaluate explicit state without ambient credentials, retries, or vendor diagnostics. */
export async function evaluate(input: unknown, config: RuntimeConfig, signal?: AbortSignal) {
  if (signal?.aborted) {
    throw evaluationError(undefined, true);
  }
  const parsed = parseInput(input);
  const model = parsed.model ?? config.model;
  if (model === "kev-latest" && !config.baseUrl) {
    throw new EvaluationError(
      "Kev requires a local System One server. Configure baseUrl in TypeSafe plugin Settings.",
      "unsupported-input",
    );
  }
  if (!config.baseUrl && !config.apiKey) {
    throw new Error("TypeSafe API key is missing. Configure a SecretRef in plugin Settings.");
  }
  try {
    const wireInput = config.baseUrl ? localInput(parsed) : parsed;
    const response = await requestEvaluation({
      body: { ...wireInput, model },
      apiKey: config.baseUrl ? undefined : config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      signal,
    });
    signal?.throwIfAborted();
    const evaluation = config.baseUrl
      ? parseLocalResult(response, wireInput, parsed)
      : parseResult(response, parsed);
    if (!config.baseUrl && config.apiKey && JSON.stringify(evaluation).includes(config.apiKey)) {
      throw new Error("Invalid TypeSafe response.");
    }
    return { evaluation };
  } catch (error) {
    throw evaluationError(error, signal?.aborted ?? false);
  }
}
