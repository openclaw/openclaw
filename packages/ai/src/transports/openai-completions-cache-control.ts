import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CacheRetention } from "../types.js";
import {
  splitSystemPromptCacheBoundaryForWire,
  splitSystemPromptRelocatableBoundary,
  stripSystemPromptRelocatableBoundary,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY,
} from "../utils/system-prompt-cache-boundary.js";
import type { resolveAnthropicEphemeralCacheControl } from "./anthropic-payload-policy.js";
import type { ResolvedOpenAICompletionsCompat } from "./openai-completions-compat.js";

// Payload identity lasts only for one request. Wrappers must not reinterpret a
// builder's already-shaped boundary or its transient-message exclusions.
const shapedPayloads = new WeakSet<object>();

type CacheControl = NonNullable<ReturnType<typeof resolveAnthropicEphemeralCacheControl>>;

export function resolveCompletionsCacheControl(
  compat: Pick<
    ResolvedOpenAICompletionsCompat,
    "cacheControlFormat" | "supportsLongCacheRetention" | "configuredSupportsLongCacheRetention"
  >,
  retention: CacheRetention,
  openRouterRoute: boolean,
): CacheControl | undefined {
  if (compat.cacheControlFormat !== "anthropic" || retention === "none") {
    return undefined;
  }
  return {
    type: "ephemeral",
    ...(retention === "long" &&
    compat.supportsLongCacheRetention &&
    (openRouterRoute || compat.configuredSupportsLongCacheRetention === true)
      ? { ttl: "1h" }
      : {}),
  };
}

/** Shared Chat Completions policy; repeated wrapper application preserves existing checkpoints. */
export function applyCompletionsAnthropicCacheControl(
  payload: Record<string, unknown>,
  cacheControl: CacheControl | null = { type: "ephemeral" },
  cacheOptOutIndexes: ReadonlySet<number> = new Set(),
  markTools = true,
  markMessages = true,
  systemOnly = false,
  sharedSystemCheckpoint = false,
): void {
  if (shapedPayloads.has(payload)) {
    return;
  }
  shapedPayloads.add(payload);
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  let lastToolIndex = -1;
  for (let index = 0; index < tools.length; index++) {
    const tool: unknown = tools[index];
    if (isRecord(tool)) {
      lastToolIndex = index;
      if (Object.hasOwn(tool, "cache_control")) {
        const unmarked = { ...tool };
        delete unmarked.cache_control;
        tools[index] = unmarked;
      }
    }
  }
  const blocks = messages
    .filter(isRecord)
    .flatMap((message) => (Array.isArray(message.content) ? message.content.filter(isRecord) : []));
  // The opening OpenRouter Anthropic turn may add a fourth shared-system breakpoint.
  for (const block of blocks) {
    delete block.cache_control;
  }
  if (!cacheControl) {
    return;
  }
  const markText = (message: Record<string, unknown>, splitBoundary: boolean): boolean => {
    if (typeof message.content === "string" && message.content) {
      message.content = [{ type: "text", text: message.content }];
    }
    const content = message.content;
    if (!Array.isArray(content)) {
      return false;
    }
    for (let i = content.length - 1; i >= 0; i--) {
      const block: unknown = content[i];
      if (
        !isRecord(block) ||
        block.type !== "text" ||
        typeof block.text !== "string" ||
        !block.text
      ) {
        continue;
      }
      const split = splitBoundary ? splitSystemPromptCacheBoundaryForWire(block.text) : undefined;
      if (split) {
        content.splice(
          i,
          1,
          ...(split.stablePrefix
            ? [{ type: "text", text: split.stablePrefix, cache_control: cacheControl }]
            : []),
          ...(split.dynamicSuffix ? [{ type: "text", text: split.dynamicSuffix }] : []),
        );
        if (!split.stablePrefix) {
          return false;
        }
      } else {
        block.cache_control = cacheControl;
      }
      return true;
    }
    return false;
  };

  if (!systemOnly && markTools && lastToolIndex >= 0) {
    // Request-specific markers must not mutate a reusable provider descriptor.
    tools[lastToolIndex] = { ...tools[lastToolIndex], cache_control: cacheControl };
  }
  // String-only endpoints cannot carry block markers; wrappers retain this decision.
  if (!markMessages) {
    return;
  }
  const system = messages.find(
    (message) => isRecord(message) && (message.role === "system" || message.role === "developer"),
  );
  if (isRecord(system)) {
    markText(system, true);
    if (sharedSystemCheckpoint && Array.isArray(system.content)) {
      const openingTurn = !messages.some(
        (message) => isRecord(message) && message.role === "assistant",
      );
      for (let i = 0; i < system.content.length; i++) {
        const block: unknown = system.content[i];
        if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
          continue;
        }
        const raw = block.text;
        const wireText = stripSystemPromptRelocatableBoundary(raw);
        const seam = openingTurn ? splitSystemPromptRelocatableBoundary(raw) : undefined;
        const start = raw.indexOf(SYSTEM_PROMPT_RELOCATABLE_BOUNDARY);
        if (!seam?.relocatable || start < 0) {
          block.text = wireText;
          continue;
        }
        const sharedText = raw.slice(0, start);
        const runtimeText = wireText.slice(sharedText.length);
        system.content.splice(
          i,
          1,
          ...(sharedText ? [{ type: "text", text: sharedText, cache_control: cacheControl }] : []),
          ...(runtimeText ? [{ type: "text", text: runtimeText }] : []),
        );
        break;
      }
    }
  }
  // OpenRouter Gemini caches one whole systemInstruction; Runtime facts were
  // moved to the first user turn by the converter when a carrier exists.
  if (systemOnly) {
    return;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message: unknown = messages[i];
    if (
      !cacheOptOutIndexes.has(i) &&
      isRecord(message) &&
      (message.role === "user" || message.role === "tool") &&
      markText(message, false)
    ) {
      return;
    }
  }
}
