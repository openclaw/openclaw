import type { RuntimeConfig } from "./config.js";
import { evaluationError } from "./errors.js";
import { parseInput, parseResult } from "./schema.js";
import { requestEvaluation } from "./transport.js";

/** Evaluate explicit state without ambient credentials, retries, or vendor diagnostics. */
export async function evaluate(input: unknown, config: RuntimeConfig, signal?: AbortSignal) {
  if (signal?.aborted) {
    throw evaluationError(undefined, true);
  }
  const parsed = parseInput(input);
  if (!config.apiKey) {
    throw new Error("TypeSafe API key is missing. Configure a SecretRef in plugin Settings.");
  }
  try {
    const response = await requestEvaluation({
      body: { ...parsed, model: parsed.model ?? config.model },
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      signal,
    });
    signal?.throwIfAborted();
    const evaluation = parseResult(response, parsed);
    if (JSON.stringify(evaluation).includes(config.apiKey)) {
      throw new Error("Invalid TypeSafe response.");
    }
    return { evaluation };
  } catch (error) {
    throw evaluationError(error, signal?.aborted ?? false);
  }
}
