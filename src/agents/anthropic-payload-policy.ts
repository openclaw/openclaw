import { resolveProviderRequestCapabilities } from "./provider-attribution.js";
import {
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "./system-prompt-cache-boundary.js";

export type AnthropicServiceTier = "auto" | "standard_only";

export type AnthropicEphemeralCacheControl = {
  type: "ephemeral";
  ttl?: "1h";
};

export type AnthropicServerCompactionConfig = {
  compactThreshold?: number;
  instructions?: string;
  pauseAfterCompaction?: boolean;
};

export const ANTHROPIC_MIN_COMPACTION_TRIGGER_TOKENS = 50_000;

type AnthropicPayloadPolicyInput = {
  api?: string;
  baseUrl?: string;
  cacheRetention?: "short" | "long" | "none";
  enableCacheControl?: boolean;
  provider?: string;
  serviceTier?: AnthropicServiceTier;
};

export type AnthropicPayloadPolicy = {
  allowsServiceTier: boolean;
  systemCacheControl: AnthropicEphemeralCacheControl | undefined;
  messageCacheControl: AnthropicEphemeralCacheControl | undefined;
  serviceTier: AnthropicServiceTier | undefined;
};

function resolveBaseUrlHostname(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

function isLongTtlEligibleEndpoint(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== "string") {
    return false;
  }
  const hostname = resolveBaseUrlHostname(baseUrl);
  if (!hostname) {
    return false;
  }
  return (
    hostname === "api.anthropic.com" ||
    hostname === "aiplatform.googleapis.com" ||
    hostname.endsWith("-aiplatform.googleapis.com")
  );
}

function resolveAnthropicEphemeralCacheControl(
  baseUrl: string | undefined,
  cacheRetention: AnthropicPayloadPolicyInput["cacheRetention"],
): AnthropicEphemeralCacheControl | undefined {
  const retention =
    cacheRetention ?? (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");
  if (retention === "none") {
    return undefined;
  }
  const ttl = retention === "long" && isLongTtlEligibleEndpoint(baseUrl) ? "1h" : undefined;
  return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

function resolveAnthropicMessageCacheControl(
  cacheRetention: AnthropicPayloadPolicyInput["cacheRetention"],
): AnthropicEphemeralCacheControl | undefined {
  const retention =
    cacheRetention ?? (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");
  if (retention === "none") {
    return undefined;
  }
  return { type: "ephemeral" };
}

function applyAnthropicCacheControlToSystem(
  system: unknown,
  cacheControl: AnthropicEphemeralCacheControl,
): void {
  if (!Array.isArray(system)) {
    return;
  }

  const normalizedBlocks: Array<unknown> = [];
  for (const block of system) {
    if (!block || typeof block !== "object") {
      normalizedBlocks.push(block);
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") {
      normalizedBlocks.push(block);
      continue;
    }
    const split = splitSystemPromptCacheBoundary(record.text);
    if (!split) {
      if (record.cache_control === undefined) {
        record.cache_control = cacheControl;
      }
      normalizedBlocks.push(record);
      continue;
    }

    const { cache_control: existingCacheControl, ...rest } = record;
    if (split.stablePrefix) {
      normalizedBlocks.push({
        ...rest,
        text: split.stablePrefix,
        cache_control: existingCacheControl ?? cacheControl,
      });
    }
    if (split.dynamicSuffix) {
      normalizedBlocks.push({
        ...rest,
        text: split.dynamicSuffix,
      });
    }
  }

  system.splice(0, system.length, ...normalizedBlocks);
}

function stripAnthropicSystemPromptBoundary(system: unknown): void {
  if (!Array.isArray(system)) {
    return;
  }

  for (const block of system) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      record.text = stripSystemPromptCacheBoundary(record.text);
    }
  }
}

function applyAnthropicCacheControlToMessages(
  messages: unknown,
  cacheControl: AnthropicEphemeralCacheControl,
): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || typeof lastMessage !== "object") {
    return;
  }

  const record = lastMessage as Record<string, unknown>;
  if (record.role !== "user") {
    return;
  }

  const content = record.content;
  if (Array.isArray(content)) {
    const lastBlock = content[content.length - 1];
    if (!lastBlock || typeof lastBlock !== "object") {
      return;
    }
    const lastBlockRecord = lastBlock as Record<string, unknown>;
    if (
      lastBlockRecord.type === "text" ||
      lastBlockRecord.type === "image" ||
      lastBlockRecord.type === "tool_result"
    ) {
      lastBlockRecord.cache_control = cacheControl;
    }
    return;
  }

  if (typeof content === "string") {
    record.content = [
      {
        type: "text",
        text: content,
        cache_control: cacheControl,
      },
    ];
  }
}

export function resolveAnthropicPayloadPolicy(
  input: AnthropicPayloadPolicyInput,
): AnthropicPayloadPolicy {
  const capabilities = resolveProviderRequestCapabilities({
    provider: input.provider,
    api: input.api,
    baseUrl: input.baseUrl,
    capability: "llm",
    transport: "stream",
  });

  return {
    allowsServiceTier: capabilities.allowsAnthropicServiceTier,
    systemCacheControl:
      input.enableCacheControl === true
        ? resolveAnthropicEphemeralCacheControl(input.baseUrl, input.cacheRetention)
        : undefined,
    messageCacheControl:
      input.enableCacheControl === true
        ? resolveAnthropicMessageCacheControl(input.cacheRetention)
        : undefined,
    serviceTier: input.serviceTier,
  };
}

export function applyAnthropicPayloadPolicyToParams(
  payloadObj: Record<string, unknown>,
  policy: AnthropicPayloadPolicy,
): void {
  if (
    policy.allowsServiceTier &&
    policy.serviceTier !== undefined &&
    payloadObj.service_tier === undefined
  ) {
    payloadObj.service_tier = policy.serviceTier;
  }

  if (policy.systemCacheControl) {
    applyAnthropicCacheControlToSystem(payloadObj.system, policy.systemCacheControl);
  } else {
    stripAnthropicSystemPromptBoundary(payloadObj.system);
  }

  if (!policy.messageCacheControl) {
    return;
  }

  // Preserve Anthropic cache-write scope by only tagging the trailing user turn.
  applyAnthropicCacheControlToMessages(payloadObj.messages, policy.messageCacheControl);
}

function hasCompactionEdit(edits: unknown): boolean {
  return Array.isArray(edits)
    ? edits.some(
        (edit) =>
          edit &&
          typeof edit === "object" &&
          (edit as Record<string, unknown>).type === "compact_20260112",
      )
    : false;
}

export function applyAnthropicServerCompactionToParams(
  payloadObj: Record<string, unknown>,
  config: AnthropicServerCompactionConfig | undefined,
): void {
  if (!config) {
    return;
  }

  const edit: Record<string, unknown> = {
    type: "compact_20260112",
  };
  if (typeof config.compactThreshold === "number" && Number.isFinite(config.compactThreshold)) {
    edit.trigger = {
      type: "input_tokens",
      value: Math.max(ANTHROPIC_MIN_COMPACTION_TRIGGER_TOKENS, Math.floor(config.compactThreshold)),
    };
  }
  if (typeof config.pauseAfterCompaction === "boolean") {
    edit.pause_after_compaction = config.pauseAfterCompaction;
  }
  if (typeof config.instructions === "string" && config.instructions.trim().length > 0) {
    edit.instructions = config.instructions.trim();
  }

  const current = payloadObj.context_management;
  if (current === undefined) {
    payloadObj.context_management = { edits: [edit] };
    return;
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return;
  }

  const record = current as Record<string, unknown>;
  if (hasCompactionEdit(record.edits)) {
    return;
  }

  if (record.edits === undefined) {
    record.edits = [edit];
    return;
  }
  if (Array.isArray(record.edits)) {
    record.edits = [...record.edits, edit];
  }
}

export function shouldEnableAnthropicServerCompaction(
  provider: string | undefined,
  baseUrl: string | undefined,
  explicit: boolean | undefined,
): boolean {
  if (explicit !== true) {
    return false;
  }
  return provider === "anthropic" && isLongTtlEligibleEndpoint(baseUrl);
}

export function resolveAnthropicRequiredBetaFeatures(params: {
  enableServerCompaction?: boolean;
  hasCompactionBlocks?: boolean;
}): string[] {
  const features: string[] = [];
  if (params.enableServerCompaction || params.hasCompactionBlocks) {
    features.push("context-management-2025-06-27", "compact-2026-01-12");
  }
  return features;
}

export function applyAnthropicEphemeralCacheControlMarkers(
  payloadObj: Record<string, unknown>,
): void {
  const messages = payloadObj.messages;
  if (!Array.isArray(messages)) {
    return;
  }

  for (const message of messages as Array<{ role?: string; content?: unknown }>) {
    if (message.role === "system" || message.role === "developer") {
      if (typeof message.content === "string") {
        message.content = [
          { type: "text", text: message.content, cache_control: { type: "ephemeral" } },
        ];
        continue;
      }
      if (Array.isArray(message.content) && message.content.length > 0) {
        const last = message.content[message.content.length - 1];
        if (last && typeof last === "object") {
          const record = last as Record<string, unknown>;
          if (record.type !== "thinking" && record.type !== "redacted_thinking") {
            record.cache_control = { type: "ephemeral" };
          }
        }
      }
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const record = block as Record<string, unknown>;
        if (record.type === "thinking" || record.type === "redacted_thinking") {
          delete record.cache_control;
        }
      }
    }
  }
}
