import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  projectCopilotRequestFacts,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { sanitizeCopilotReplayResponsePayload } from "./connection-bound-ids.js";
import { stripCopilotAssistantThinkingMessages } from "./replay-policy.js";
import { buildCopilotRuntimeHeaders } from "./runtime-identity.js";

function patchOnPayloadResult(
  result: unknown,
  patchPayload: (payload: unknown) => unknown,
  fallbackPayload?: unknown,
): unknown {
  if (result && typeof result === "object" && "then" in result) {
    return Promise.resolve(result).then((next) => {
      patchPayload(next === undefined ? fallbackPayload : next);
      return next;
    });
  }
  patchPayload(result === undefined ? fallbackPayload : result);
  return result;
}

type CopilotAnthropicToolBlock = {
  record: Record<string, unknown>;
  idKey: "id" | "tool_use_id";
  rawId: string;
};

function normalizeCopilotAnthropicToolIds(messages: unknown[]): void {
  const blocks: CopilotAnthropicToolBlock[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const record = block as Record<string, unknown>;
      const idKey =
        record.type === "tool_use" ? "id" : record.type === "tool_result" ? "tool_use_id" : null;
      const rawId = idKey ? record[idKey] : undefined;
      if (idKey && typeof rawId === "string") {
        blocks.push({ record, idKey, rawId });
      }
    }
  }

  // Reserve valid IDs globally so an earlier invalid call cannot steal the ID
  // of a later native call; replaying this payload patch must also be stable.
  const validId = /^[a-zA-Z0-9_-]{1,64}$/;
  const reserved = new Set(
    blocks
      .filter((block) => block.idKey === "id" && validId.test(block.rawId))
      .map((block) => block.rawId),
  );
  const used = new Set(reserved);
  const claimedValid = new Set<string>();
  const pendingByRawId = new Map<string, string[]>();
  const lastResolvedByRawId = new Map<string, string>();

  const allocate = (rawId: string): string => {
    if (validId.test(rawId) && !claimedValid.has(rawId)) {
      claimedValid.add(rawId);
      return rawId;
    }

    const base = rawId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
    if (!used.has(base)) {
      used.add(base);
      return base;
    }

    for (let occurrence = 2; ; occurrence += 1) {
      const suffix = `_${occurrence}`;
      const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };

  for (const block of blocks) {
    if (block.idKey === "id") {
      const wireId = allocate(block.rawId);
      const pending = pendingByRawId.get(block.rawId);
      if (pending) {
        pending.push(wireId);
      } else {
        pendingByRawId.set(block.rawId, [wireId]);
      }
      block.record.id = wireId;
      continue;
    }

    // Upstream projection can collapse distinct raw calls to the same string;
    // consume occurrences in order so each result answers its own tool call.
    const pending = pendingByRawId.get(block.rawId);
    const wireId =
      pending?.shift() ?? lastResolvedByRawId.get(block.rawId) ?? allocate(block.rawId);
    if (pending?.length === 0) {
      pendingByRawId.delete(block.rawId);
    }
    lastResolvedByRawId.set(block.rawId, wireId);
    block.record.tool_use_id = wireId;
  }
}

function patchCopilotAnthropicPayload(payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.messages)) {
    const messages = stripCopilotAssistantThinkingMessages(record.messages);
    record.messages = messages;
    normalizeCopilotAnthropicToolIds(messages);
  }
  applyAnthropicEphemeralCacheControlMarkers(record);
}

export function wrapCopilotProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const stream = ctx.streamFn;
  if (!stream) {
    return undefined;
  }
  return (model, context, options) => {
    if (
      model.provider !== "github-copilot" ||
      !["anthropic-messages", "openai-responses", "openai-completions"].includes(model.api)
    ) {
      return stream(model, context, options);
    }
    const facts = projectCopilotRequestFacts(context.messages, "nested");
    const anthropic = model.api === "anthropic-messages";
    const originalOnPayload = options?.onPayload;
    const patchPayload = anthropic
      ? patchCopilotAnthropicPayload
      : model.api === "openai-responses"
        ? sanitizeCopilotReplayResponsePayload
        : undefined;
    return stream(model, context, {
      ...options,
      headers: buildCopilotRuntimeHeaders({
        config: ctx.config,
        headers: {
          ...model.headers,
          "x-initiator": facts.initiator,
          ...(facts.hasImages ? { "Copilot-Vision-Request": "true" } : {}),
          ...options?.headers,
        },
      }),
      ...(patchPayload
        ? {
            onPayload: (payload: unknown, payloadModel: Parameters<StreamFn>[0]) => {
              patchPayload(payload);
              return patchOnPayloadResult(
                originalOnPayload?.(payload, anthropic ? model : payloadModel),
                patchPayload,
                payload,
              );
            },
          }
        : {}),
    });
  };
}
