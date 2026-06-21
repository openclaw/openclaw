/** Decides whether a terminal Codex usage snapshot leaves room for the next turn. */
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isJsonObject } from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

const DEFAULT_NATIVE_THREAD_MAX_TOKENS = 300_000;
const DEFAULT_NATIVE_THREAD_RESERVE_TOKENS = 20_000;
const MIN_PROMPT_BUDGET_TOKENS = 8_000;
const MIN_PROMPT_BUDGET_RATIO = 0.5;
const PROJECTED_CHARS_PER_TOKEN = 4;

export type CodexAppServerStartupTokenGuard = {
  contextWindowTokens?: number;
  projectedTurnTokens?: number;
};

/** Conservative prompt-size estimate used by both harness and bound turns. */
export function estimateCodexAppServerProjectedTurnTokens(params: {
  prompt: string;
  developerInstructions?: string;
}): number {
  const inputChars = params.prompt.length + (params.developerInstructions?.length ?? 0);
  return Math.max(1, Math.ceil(inputChars / PROJECTED_CHARS_PER_TOKEN));
}

function toNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function readCompactionConfig(config: EmbeddedRunAttemptParams["config"] | undefined) {
  return isJsonObject(config?.agents?.defaults?.compaction)
    ? config.agents.defaults.compaction
    : undefined;
}

function resolveNativeThreadReserveTokens(
  config: EmbeddedRunAttemptParams["config"] | undefined,
): number {
  const compaction = readCompactionConfig(config);
  const reserveTokens = toNonNegativeInt(compaction?.reserveTokens);
  const reserveTokensFloor = toNonNegativeInt(compaction?.reserveTokensFloor);
  if (reserveTokens !== undefined) {
    return Math.max(reserveTokens, reserveTokensFloor ?? DEFAULT_NATIVE_THREAD_RESERVE_TOKENS);
  }
  return reserveTokensFloor ?? DEFAULT_NATIVE_THREAD_RESERVE_TOKENS;
}

function resolveNativeThreadTokenFuse(params: {
  modelContextWindow?: number;
  reserveTokens: number;
  projectedTurnTokens?: number;
}): number {
  const projectedTurnTokens = toNonNegativeInt(params.projectedTurnTokens) ?? 0;
  const contextWindow = params.modelContextWindow ?? DEFAULT_NATIVE_THREAD_MAX_TOKENS;
  const minPromptBudget = Math.min(
    MIN_PROMPT_BUDGET_TOKENS,
    Math.max(1, Math.floor(contextWindow * MIN_PROMPT_BUDGET_RATIO)),
  );
  const effectiveReserveTokens = Math.min(
    params.reserveTokens,
    Math.max(0, contextWindow - minPromptBudget),
  );
  return Math.max(1, contextWindow - effectiveReserveTokens - projectedTurnTokens);
}

function minPositive(values: Array<number | undefined>): number | undefined {
  const present = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return present.length > 0 ? Math.min(...present) : undefined;
}

/** Returns true when the last terminal usage snapshot leaves too little turn headroom. */
export function shouldRotateCodexAppServerStartupBinding(params: {
  binding: CodexAppServerThreadBinding | undefined;
  config: EmbeddedRunAttemptParams["config"] | undefined;
  contextWindowTokens?: number;
  projectedTurnTokens?: number;
}): boolean {
  const binding = params.binding;
  const currentTokens = binding?.nativeContextUsage?.currentTokens;
  if (!binding?.threadId || currentTokens === undefined) {
    return false;
  }
  const modelContextWindow = minPositive([binding.modelContextWindow, params.contextWindowTokens]);
  const reserveTokens = resolveNativeThreadReserveTokens(params.config);
  const maxTokens = resolveNativeThreadTokenFuse({
    modelContextWindow,
    reserveTokens,
    projectedTurnTokens: params.projectedTurnTokens,
  });
  if (currentTokens < maxTokens) {
    return false;
  }
  embeddedAgentLog.warn(
    "codex app-server thread usage left too little prompt headroom; starting a fresh thread",
    {
      threadId: binding.threadId,
      currentTokens,
      maxTokens,
      modelContextWindow,
      reserveTokens,
      projectedTurnTokens: params.projectedTurnTokens,
    },
  );
  return true;
}

export const testing = {
  resolveNativeThreadReserveTokens,
  resolveNativeThreadTokenFuse,
};
