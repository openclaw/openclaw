import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSession, PromptOptions } from "@mariozechner/pi-coding-agent";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../../infra/backoff.js";
import { resolveFailoverReasonFromError } from "../failover-error.js";
import { classifyFailoverReason } from "../pi-embedded-helpers.js";
import { log } from "./logger.js";

const RATE_LIMIT_RETRY_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 5_000,
  factor: 2,
  jitter: 0.2,
};

const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 30_000;

export interface PromptRetryContext {
  prompt: () => Promise<void>;
  classifyTerminalFailure: () => { isRateLimit: boolean; rawError: unknown } | null;
  isReplaySafe: () => boolean;
  rewind: () => void;
  abortSignal?: AbortSignal;
  provider: string;
  modelId: string;
  computeBackoff?: (attempt: number) => number;
  sleepWithAbort?: (delayMs: number, abortSignal?: AbortSignal) => Promise<void>;
}

// --- Retry-After header parsing ---

function getRetryAfterRaw(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  // Headers instance (has .get method)
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): string | null }).get("retry-after");
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  // Plain object — case-insensitive key scan
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === "retry-after" && typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function parseRetryAfterMs(err: unknown): number | undefined {
  return walkRetryAfter(err, new Set());
}

function walkRetryAfter(err: unknown, seen: Set<unknown>): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  if (seen.has(err)) {
    return undefined;
  }
  seen.add(err);

  const obj = err as Record<string, unknown>;
  const raw =
    getRetryAfterRaw(obj.headers) ??
    getRetryAfterRaw(
      obj.response && typeof obj.response === "object"
        ? (obj.response as Record<string, unknown>).headers
        : undefined,
    );

  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      const delta = date.getTime() - Date.now();
      return delta > 0 ? delta : 0;
    }
  }

  return walkRetryAfter(obj.error, seen) ?? walkRetryAfter(obj.cause, seen);
}

// --- Core retry loop ---

export async function retryPromptOnRateLimit(ctx: PromptRetryContext): Promise<void> {
  const sleep = ctx.sleepWithAbort ?? sleepWithAbort;
  let retryCount = 0;

  while (true) {
    let didThrow = false;
    let thrownError: unknown;

    try {
      await ctx.prompt();
    } catch (err) {
      didThrow = true;
      thrownError = err;
    }

    const terminalFailure = didThrow ? null : ctx.classifyTerminalFailure();
    const isRateLimit = didThrow
      ? resolveFailoverReasonFromError(thrownError) === "rate_limit"
      : (terminalFailure?.isRateLimit ?? false);

    if (!isRateLimit) {
      if (didThrow) {
        throw thrownError;
      }
      return;
    }

    if (retryCount >= MAX_RETRIES || ctx.abortSignal?.aborted || !ctx.isReplaySafe()) {
      if (retryCount >= MAX_RETRIES && retryCount > 0) {
        log.warn(
          `[rate-limit-retry] exhausted ${retryCount}/${MAX_RETRIES} retries for ${ctx.provider}/${ctx.modelId}`,
        );
      }
      if (didThrow) {
        throw thrownError;
      }
      return;
    }

    retryCount += 1;
    ctx.rewind();

    const retryAfterMs = parseRetryAfterMs(didThrow ? thrownError : terminalFailure?.rawError);
    const backoffMs =
      ctx.computeBackoff?.(retryCount) ?? computeBackoff(RATE_LIMIT_RETRY_POLICY, retryCount);
    const delayMs = Math.min(Math.max(retryAfterMs ?? 0, backoffMs), MAX_RETRY_AFTER_MS);

    log.warn(
      `[rate-limit-retry] rate-limit from ${ctx.provider}/${ctx.modelId}, retry ${retryCount}/${MAX_RETRIES} in ${delayMs}ms`,
    );

    try {
      await sleep(delayMs, ctx.abortSignal);
    } catch (err) {
      if (ctx.abortSignal?.aborted) {
        throw new Error("aborted", { cause: err });
      }
      throw err;
    }
  }
}

// --- Attempt-layer adapter ---

export async function runPromptWithRateLimitRetry(params: {
  activeSession: {
    prompt: AgentSession["prompt"];
    messages: AgentSession["messages"];
    agent: { state: { messages: AgentMessage[] } };
  };
  effectivePrompt: string;
  images: NonNullable<PromptOptions["images"]>;
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  assistantTexts: string[];
  toolMetas: Array<unknown>;
  didSendViaMessagingTool: () => boolean;
  getSuccessfulCronAdds: () => number;
  getReasoningEmitCount: () => number;
  didEmitAssistantUpdate: () => boolean;
  getCompactionCount: () => number;
  abortSignal?: AbortSignal;
  provider: string;
  modelId: string;
  computeBackoff?: (attempt: number) => number;
  sleepWithAbort?: (delayMs: number, abortSignal?: AbortSignal) => Promise<void>;
}): Promise<void> {
  let preRetryMessages = params.activeSession.messages.slice();
  let compactionBaseline = params.getCompactionCount();
  let reasoningBaseline = params.getReasoningEmitCount();

  await retryPromptOnRateLimit({
    prompt: () =>
      params.images.length > 0
        ? params.abortable(
            params.activeSession.prompt(params.effectivePrompt, { images: params.images }),
          )
        : params.abortable(params.activeSession.prompt(params.effectivePrompt)),

    classifyTerminalFailure: () => {
      const messages = params.activeSession.messages;
      // After compaction, messages may be shorter than the pre-retry snapshot.
      // Skip the length guard when compaction occurred during this prompt.
      if (
        params.getCompactionCount() <= compactionBaseline &&
        messages.length <= preRetryMessages.length
      ) {
        return null;
      }
      const last = messages[messages.length - 1];
      if (last?.role !== "assistant") {
        return null;
      }
      if ((last as { stopReason?: string }).stopReason !== "error") {
        return null;
      }
      const reason = classifyFailoverReason((last as { errorMessage?: string }).errorMessage ?? "");
      return {
        isRateLimit: reason === "rate_limit",
        rawError: last,
      };
    },

    isReplaySafe: () =>
      params.assistantTexts.length === 0 &&
      params.toolMetas.length === 0 &&
      !params.didSendViaMessagingTool() &&
      params.getSuccessfulCronAdds() === 0 &&
      params.getReasoningEmitCount() <= reasoningBaseline &&
      !params.didEmitAssistantUpdate(),

    rewind: () => {
      const currentCompactions = params.getCompactionCount();
      if (currentCompactions > compactionBaseline) {
        // Compaction during prompt — pre-retry snapshot is stale.
        // Derive post-compaction baseline by stripping messages the prompt added.
        // isReplaySafe() confirmed no assistant text, tools, or outbound messages,
        // so at most two messages were appended: user prompt + error assistant.
        const current = params.activeSession.messages;
        let end = current.length;
        if (
          end > 0 &&
          current[end - 1]?.role === "assistant" &&
          (current[end - 1] as { stopReason?: string }).stopReason === "error"
        ) {
          end--;
        }
        if (end > 0 && current[end - 1]?.role === "user") {
          end--;
        }
        preRetryMessages = current.slice(0, end);
        compactionBaseline = currentCompactions;
        reasoningBaseline = params.getReasoningEmitCount();
      }
      if (params.activeSession.messages.length !== preRetryMessages.length) {
        params.activeSession.agent.state.messages = preRetryMessages.slice();
      }
    },

    abortSignal: params.abortSignal,
    provider: params.provider,
    modelId: params.modelId,
    computeBackoff: params.computeBackoff,
    sleepWithAbort: params.sleepWithAbort,
  });
}
