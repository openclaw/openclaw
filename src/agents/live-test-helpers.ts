/**
 * Shared helpers for live provider tests and timeout-wrapped completions.
 */
import { completeSimple } from "../llm/stream.js";
import type { Api, Model } from "../llm/types.js";

export {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveProfileKeyModeEnabled,
  isLiveTestEnabled,
  readLiveTestConfig,
} from "./live-test-config.js";

export type CompleteSimpleContent<TApi extends Api = Api> = Awaited<
  ReturnType<typeof completeSimple<TApi>>
>["content"];

/** Resolve whether profile or env credentials should be tried first. */
export function resolveLiveCredentialPrecedence(
  provider: string,
  requireProfileKeys: boolean,
): "profile-first" | "env-first" {
  return requireProfileKeys || provider === "openai" ? "profile-first" : "env-first";
}

/** Write a namespaced live-test progress line to stderr. */
export function logLiveProgress(message: string): void {
  process.stderr.write(`[live] ${message}\n`);
}

/** Run completeSimple with abort and hard-timeout guards for live tests. */
export async function completeSimpleWithTimeout<TApi extends Api>(
  model: Model<TApi>,
  context: Parameters<typeof completeSimple<TApi>>[1],
  options: Parameters<typeof completeSimple<TApi>>[2],
  timeoutMs: number,
  timeoutMessage = `model call timed out after ${timeoutMs}ms`,
): Promise<Awaited<ReturnType<typeof completeSimple<TApi>>>> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  abortTimer.unref?.();
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completeSimple(model, context, {
        ...options,
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        hardTimer = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
        hardTimer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(hardTimer);
  }
}
