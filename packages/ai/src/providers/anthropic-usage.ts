import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { Usage } from "../types.js";

type AnthropicUsagePayload = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_creation?: unknown;
  iterations?: unknown;
};

export type AnthropicCacheWriteUsage = {
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

export type AnthropicPromptUsageSnapshot = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
};

export type AnthropicIterationUsageSnapshot = {
  contextPromptTokens: number;
  totalTokens: number;
};

export type AnthropicIterationUsageResult =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "valid"; usage: AnthropicIterationUsageSnapshot };

type AnthropicBilledUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
};

const BILLED_USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const;

function readAnthropicBilledUsage(
  usage: AnthropicUsagePayload,
  missingCacheTokens?: 0,
): Partial<AnthropicBilledUsage> {
  return {
    input: readAnthropicUsageTokenCount(usage.input_tokens),
    output: readAnthropicUsageTokenCount(usage.output_tokens),
    cacheRead: readAnthropicUsageTokenCount(usage.cache_read_input_tokens ?? missingCacheTokens),
    cacheWrite: readAnthropicUsageTokenCount(
      usage.cache_creation_input_tokens ?? missingCacheTokens,
    ),
    cacheWrite1h: readAnthropicCacheWriteUsage(usage).cacheWrite1h,
  };
}

function applyAnthropicBilledUsage(target: Usage, resolved: Partial<AnthropicBilledUsage>): void {
  for (const key of BILLED_USAGE_KEYS) {
    const value = resolved[key];
    if (value !== undefined) {
      target[key] = value;
    }
  }
  target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
}

function readAnthropicIterationUsage(value: unknown): AnthropicBilledUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const { input, output, cacheRead, cacheWrite, cacheWrite1h } = readAnthropicBilledUsage(value);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, cacheWrite1h: cacheWrite1h ?? 0 };
}

export function readAnthropicUsageTokenCount(value: unknown): number | undefined {
  return asNonNegativeFiniteNumber(value);
}

export function readAnthropicCacheWriteUsage(
  usage: AnthropicUsagePayload,
): AnthropicCacheWriteUsage {
  if (!usage.cache_creation || typeof usage.cache_creation !== "object") {
    return {};
  }
  const cacheCreation = usage.cache_creation as Record<string, unknown>;
  const cacheWrite5m = readAnthropicUsageTokenCount(cacheCreation.ephemeral_5m_input_tokens);
  const cacheWrite1h = readAnthropicUsageTokenCount(cacheCreation.ephemeral_1h_input_tokens);
  return {
    ...(cacheWrite5m !== undefined ? { cacheWrite5m } : {}),
    ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
  };
}

export function readAnthropicPromptUsageSnapshot(
  usage: AnthropicUsagePayload,
): AnthropicPromptUsageSnapshot | undefined {
  const input = readAnthropicUsageTokenCount(usage.input_tokens);
  const cacheRead =
    usage.cache_read_input_tokens == null
      ? 0
      : readAnthropicUsageTokenCount(usage.cache_read_input_tokens);
  const cacheWrite =
    usage.cache_creation_input_tokens == null
      ? 0
      : readAnthropicUsageTokenCount(usage.cache_creation_input_tokens);
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { input, cacheRead, cacheWrite };
}

export function readLastAnthropicIterationUsage(
  usage: AnthropicUsagePayload,
): AnthropicIterationUsageResult {
  if (usage.iterations == null) {
    return { state: "absent" };
  }
  if (!Array.isArray(usage.iterations) || usage.iterations.length === 0) {
    return { state: "invalid" };
  }
  // Anthropic documents the final iteration as the true context window.
  // Top-level cache fields remain cumulative billing totals across iterations.
  const iteration = readAnthropicIterationUsage(usage.iterations.at(-1));
  if (!iteration) {
    return { state: "invalid" };
  }
  const contextPromptTokens = iteration.input + iteration.cacheRead + iteration.cacheWrite;
  return {
    state: "valid",
    usage: {
      contextPromptTokens,
      totalTokens: contextPromptTokens + iteration.output,
    },
  };
}

function readAnthropicCompactionBilledUsage(iterations: unknown): AnthropicBilledUsage | undefined {
  if (!Array.isArray(iterations) || iterations.length === 0) {
    return undefined;
  }
  let sawCompaction = false;
  const billed: AnthropicBilledUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
  };
  for (const iteration of iterations) {
    const resolved = readAnthropicIterationUsage(iteration);
    if (!resolved) {
      return undefined;
    }
    sawCompaction ||= iteration.type === "compaction";
    for (const key of BILLED_USAGE_KEYS) {
      billed[key] += resolved[key];
    }
  }
  return sawCompaction ? billed : undefined;
}

/** Record independent billing buckets without treating zero placeholders as context proof. */
export function applyAnthropicMessageStartUsage(
  target: Usage,
  payload: AnthropicUsagePayload,
): AnthropicPromptUsageSnapshot | undefined {
  const promptUsage = readAnthropicPromptUsageSnapshot(payload);
  const promptTokens = promptUsage
    ? promptUsage.input + promptUsage.cacheRead + promptUsage.cacheWrite
    : 0;
  const resolved = readAnthropicBilledUsage(payload, 0);
  applyAnthropicBilledUsage(target, resolved);
  if (promptTokens > 0 && resolved.output !== undefined) {
    target.contextUsage = {
      state: "available",
      promptTokens,
      totalTokens: promptTokens + target.output,
    };
  }
  return promptTokens > 0 ? promptUsage : undefined;
}

/** Keep billing and context distinct; omitted usage preserves the last snapshot. */
export function applyAnthropicMessageDeltaUsage(
  target: Usage,
  usage: AnthropicUsagePayload | undefined,
  messageStartPromptUsage: AnthropicPromptUsageSnapshot | undefined,
): void {
  if (!usage) {
    return;
  }
  const billedIterations = readAnthropicCompactionBilledUsage(usage.iterations);
  const reported = readAnthropicBilledUsage(usage);
  // Match the SDK accumulator: absent or null cache counters preserve prior values.
  applyAnthropicBilledUsage(target, billedIterations ?? reported);
  const iterationUsage = readLastAnthropicIterationUsage(usage);
  if (iterationUsage.state === "valid") {
    target.contextUsage = {
      state: "available",
      promptTokens: iterationUsage.usage.contextPromptTokens,
      totalTokens: iterationUsage.usage.totalTokens,
    };
  } else if (iterationUsage.state === "invalid") {
    target.contextUsage = { state: "unavailable" };
  } else if (
    reported.output !== undefined &&
    (messageStartPromptUsage !== undefined ||
      ((reported.cacheRead !== undefined || reported.cacheWrite !== undefined) &&
        readAnthropicPromptUsageSnapshot(usage) !== undefined))
  ) {
    const promptTokens = target.input + target.cacheRead + target.cacheWrite;
    target.contextUsage = {
      state: "available",
      promptTokens,
      totalTokens: promptTokens + target.output,
    };
  } else {
    target.contextUsage = { state: "unavailable" };
  }
}
