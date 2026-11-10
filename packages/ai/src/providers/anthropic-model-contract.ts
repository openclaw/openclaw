// Model-bound thinking cannot be exposed or replayed after a model switch.
import {
  bindsClaudeThinkingPrefix,
  CLAUDE_FABLE_5_THINKING_PROFILE,
  CLAUDE_HAIKU_55_THINKING_PROFILE,
  CLAUDE_OPUS_55_THINKING_PROFILE,
  CLAUDE_SONNET_55_THINKING_PROFILE,
  rejectsClaudeAssistantPrefill,
  requiresClaudeDefaultSampling,
  requiresClaudeMandatoryAdaptiveThinking,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeHaiku55ModelIdentity,
  resolveClaudeModelIdentity,
  resolveClaudeNativeThinkingLevelMap,
  resolveClaudeOpus55ModelIdentity,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet55ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
  usesClaude5RequestContract,
} from "@openclaw/llm-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { clampThinkingLevel } from "../model-utils.js";
import type { AnthropicEffort } from "../provider-options.js";
import type {
  Context,
  Model,
  ModelRequestHeaders,
  ModelThinkingLevel,
  SimpleStreamOptions,
  StopReason,
} from "../types.js";
import { headersToRecord } from "../utils/headers.js";
export {
  bindsClaudeThinkingPrefix,
  requiresClaudeBetweenToolsThinking,
  requiresClaudeDefaultSampling,
  requiresClaudeMandatoryAdaptiveThinking,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeHaiku55ModelIdentity,
  resolveClaudeModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeNativeThinkingLevelMap,
  resolveClaudeOpus55ModelIdentity,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  resolveClaudeSonnet55ModelIdentity,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "@openclaw/llm-core";

// Starting Claude Code identity for OAuth requests. Anthropic gates newer models
// with claude_code_version_too_old and names the required version; the transport
// adopts that answer (see raiseClaudeCodeVersionFloor), so new models never
// require changing this value. A newer installed CLI also wins.
export const ANTHROPIC_CLAUDE_CODE_VERSION = "2.1.280";

// Process-wide: the requirement is per Anthropic, not per session or credential.
// A restart forgets it and costs one rejected request to learn again.
let learnedClaudeCodeVersion: string | undefined;

function parseClaudeCodeVersion(value: string | undefined): number[] | undefined {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const parts = match?.slice(1).map(Number);
  return parts?.every(Number.isSafeInteger) ? parts : undefined;
}

function isNewerClaudeCodeVersion(candidate: string | undefined, current: string): boolean {
  const next = parseClaudeCodeVersion(candidate);
  const base = parseClaudeCodeVersion(current);
  if (!next || !base) {
    return false;
  }
  const index = next.findIndex((part, i) => part !== base[i]);
  return index !== -1 && next[index]! > base[index]!;
}

function currentClaudeCodeVersionFloor(): string {
  return learnedClaudeCodeVersion ?? ANTHROPIC_CLAUDE_CODE_VERSION;
}

/**
 * Read the Claude Code version Anthropic requires from a
 * claude_code_version_too_old rejection (SDK APIError or transport error body).
 */
export function readRequiredClaudeCodeVersion(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as { status?: unknown; error?: unknown; errorBody?: unknown };
  if (record.status !== 400) {
    return undefined;
  }
  const body = record.errorBody ?? record.error;
  const payload =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error?: unknown }).error
      : body;
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const { message, details } = payload as { message?: unknown; details?: unknown };
  const code =
    typeof details === "object" && details !== null
      ? (details as { error_code?: unknown }).error_code
      : undefined;
  if (code !== "claude_code_version_too_old" || typeof message !== "string") {
    return undefined;
  }
  const required = message.match(/version (\d+\.\d+\.\d+) or newer is required/)?.[1];
  return parseClaudeCodeVersion(required) ? required : undefined;
}

/** Adopt a version Anthropic required; true when it raised the floor and a retry can help. */
export function raiseClaudeCodeVersionFloor(required: string): boolean {
  if (!isNewerClaudeCodeVersion(required, currentClaudeCodeVersionFloor())) {
    return false;
  }
  learnedClaudeCodeVersion = required;
  return true;
}

/** Test seam: forget the learned requirement. */
export function resetLearnedClaudeCodeVersionForTest(): void {
  learnedClaudeCodeVersion = undefined;
}

/** Build OAuth headers and the matching billing identity from one request snapshot. */
export function buildAnthropicClaudeCodeIdentity(
  betaHeader: string | undefined,
  ...headerSources: (ModelRequestHeaders | undefined)[]
): { headers: Record<string, string>; version: string } {
  const headers = new Headers({
    accept: "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
    ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
    "x-app": "cli",
  });
  for (const source of headerSources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (value === null) {
        headers.delete(name);
      } else {
        headers.set(name, value);
      }
    }
  }
  let version = currentClaudeCodeVersionFloor();
  const candidate = headers.get("user-agent")?.match(/^claude-cli\/(\d+\.\d+\.\d+)$/)?.[1];
  if (isNewerClaudeCodeVersion(candidate, version)) {
    version = candidate!;
  }
  headers.set("user-agent", `claude-cli/${version}`);
  return { headers: headersToRecord(headers), version };
}

type ReplayModelRef = {
  provider?: string;
  api?: string;
  modelId?: string;
  responseModelId?: string;
  modelParams?: Record<string, unknown>;
};

function normalizeModelId(modelId?: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  const unprefixed = normalized.startsWith("anthropic/")
    ? normalized.slice("anthropic/".length)
    : normalized;
  return unprefixed.replace(/[._\s]+/g, "-");
}

function normalizeApi(api?: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(api);
  return normalized === "openclaw-anthropic-messages-transport" ? "anthropic-messages" : normalized;
}

function hasConcreteResponseModel(ref: ReplayModelRef): boolean {
  const responseModelId = normalizeModelId(ref.responseModelId);
  // Deployment APIs may echo the requested alias. Only a different response
  // model proves the backing identity and overrides configured metadata.
  return responseModelId.length > 0 && responseModelId !== normalizeModelId(ref.modelId);
}

export function usesClaudeFable5MessagesContract(model: {
  id?: string;
  params?: Record<string, unknown>;
  api?: string;
}): boolean {
  return (
    normalizeApi(model.api) === "anthropic-messages" &&
    resolveClaudeFable5ModelIdentity(model) !== undefined
  );
}

/** Return whether streamed output must wait for the terminal refusal decision. */
export function usesClaudeStreamingRefusalContract(model: {
  id?: string;
  params?: Record<string, unknown>;
  api?: string;
}): boolean {
  return normalizeApi(model.api) === "anthropic-messages" && usesClaude5RequestContract(model);
}

export function requiresClaudeAdaptiveThinking(model: {
  id?: string;
  params?: Record<string, unknown>;
  api?: string;
}): boolean {
  if (normalizeApi(model.api) !== "anthropic-messages") {
    return false;
  }
  return requiresClaudeMandatoryAdaptiveThinking(model);
}

/** Return whether omitted thinking should default to adaptive mode. */
export function defaultsClaudeAdaptiveThinking(model: {
  id?: string;
  params?: Record<string, unknown>;
  api?: string;
}): boolean {
  return (
    requiresClaudeAdaptiveThinking(model) ||
    (normalizeApi(model.api) === "anthropic-messages" && usesClaude5RequestContract(model))
  );
}

/** Resolve provider-native effort once for direct and managed Claude requests. */
export function resolveAnthropicThinkingEffort(
  model: Model<"anthropic-messages">,
  level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
  const requestedLevel: ModelThinkingLevel | undefined =
    level ??
    (resolveClaudeHaiku55ModelIdentity(model)
      ? CLAUDE_HAIKU_55_THINKING_PROFILE.defaultLevel
      : resolveClaudeOpus55ModelIdentity(model)
        ? CLAUDE_OPUS_55_THINKING_PROFILE.defaultLevel
        : resolveClaudeSonnet55ModelIdentity(model)
          ? CLAUDE_SONNET_55_THINKING_PROFILE.defaultLevel
          : resolveClaudeFable5ModelIdentity(model)
            ? CLAUDE_FABLE_5_THINKING_PROFILE.defaultLevel
            : undefined);
  const thinkingLevelMap = resolveClaudeNativeThinkingLevelMap(model);
  const clampModel = {
    ...model,
    ...(typeof model.params?.canonicalModelId === "string" ? { reasoning: true } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
  const resolvedLevel = requestedLevel ? clampThinkingLevel(clampModel, requestedLevel) : undefined;
  const mapped = resolvedLevel ? thinkingLevelMap?.[resolvedLevel] : undefined;
  if (typeof mapped === "string") {
    return mapped as AnthropicEffort;
  }
  switch (resolvedLevel) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "xhigh":
      return supportsClaudeNativeXhighEffort(model) ? "xhigh" : "high";
    case "max":
      return supportsClaudeNativeMaxEffort(model) ? "max" : "high";
    default:
      return "high";
  }
}

/** Normalize Anthropic and Anthropic-compatible terminal reasons identically. */
export function mapAnthropicStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "compaction":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
    case "sensitive":
      return "error";
    default:
      throw new Error(`Unhandled stop reason: ${String(reason)}`);
  }
}

/** Remove unsupported assistant prefills while preserving completed tool-use turns. */
export function prepareClaudeNoPrefillRequestContext(model: Model, context: Context): Context {
  if (!rejectsClaudeAssistantPrefill(model)) {
    return context;
  }

  let end = context.messages.length;
  while (end > 0) {
    const message = context.messages[end - 1];
    if (
      message?.role !== "assistant" ||
      (Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall"))
    ) {
      break;
    }
    end -= 1;
  }
  return end === context.messages.length
    ? context
    : { ...context, messages: context.messages.slice(0, end) };
}

export function applyClaudeRequestContract(
  params: {
    temperature?: unknown;
    top_p?: unknown;
    top_k?: unknown;
    service_tier?: unknown;
  },
  model: {
    id?: string;
    params?: Record<string, unknown>;
    api?: string;
  },
): void {
  if (normalizeApi(model.api) !== "anthropic-messages") {
    return;
  }
  if (!requiresClaudeDefaultSampling(model)) {
    return;
  }
  delete params.temperature;
  delete params.top_p;
  delete params.top_k;
  if (
    resolveClaudeOpus5ModelIdentity(model) !== undefined ||
    resolveClaudeSonnet5ModelIdentity(model) !== undefined ||
    resolveClaudeHaiku55ModelIdentity(model) !== undefined
  ) {
    delete params.service_tier;
  }
}

/**
 * Claude identity of a transcript or target model on the Messages API. The
 * response model wins when it differs, so server-side fallbacks keep their own identity.
 */
function resolveReplayClaudeIdentity(ref: ReplayModelRef): string | undefined {
  if (normalizeApi(ref.api) !== "anthropic-messages") {
    return undefined;
  }
  const modelRef = hasConcreteResponseModel(ref)
    ? { id: ref.responseModelId }
    : { id: ref.modelId, params: ref.modelParams };
  const identity = resolveClaudeModelIdentity(modelRef);
  return identity.startsWith("claude-") ? identity : undefined;
}

/** The destination is fixed during one synchronous history transform. */
export function prepareModelBoundThinkingReplay(
  target: Pick<Model, "api" | "provider" | "id" | "params">,
) {
  const targetApi = normalizeApi(target.api);
  const targetIdentity = resolveReplayClaudeIdentity({
    api: target.api,
    modelId: target.id,
    modelParams: target.params,
  });
  const targetProvider = normalizeLowercaseStringOrEmpty(target.provider);
  const targetModelId = normalizeModelId(target.id);
  return (source: ReplayModelRef): "default" | "preserve" | "drop" => {
    const sourceApi = normalizeApi(source.api);
    const sourceIdentity = resolveReplayClaudeIdentity(source);
    if (!sourceIdentity && !targetIdentity) {
      return "default";
    }
    if (sourceIdentity && targetIdentity && sourceApi === targetApi) {
      // A prefix-bound block is valid only after the exact system prompt and
      // tools it was produced with, and those differ per model, so it cannot
      // follow a switch. Unbound blocks stay; the API itself drops what the
      // target cannot read, so OpenClaw keeps no table of which model reads which.
      return sourceIdentity === targetIdentity || !bindsClaudeThinkingPrefix({ id: sourceIdentity })
        ? "preserve"
        : "drop";
    }
    if (
      !sourceIdentity &&
      !hasConcreteResponseModel(source) &&
      targetIdentity &&
      normalizeLowercaseStringOrEmpty(source.provider) === targetProvider &&
      sourceApi === targetApi &&
      normalizeModelId(source.modelId) === targetModelId
    ) {
      return "preserve";
    }
    return sourceApi === targetApi && sourceIdentity === targetIdentity ? "preserve" : "drop";
  };
}
