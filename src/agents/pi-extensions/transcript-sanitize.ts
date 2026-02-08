/**
 * Transcript repair/sanitization extension.
 *
 * Runs on every context build to prevent strict provider request rejections:
 * - duplicate or displaced tool results (Anthropic-compatible APIs, MiniMax, Cloud Code Assist)
 * - Cloud Code Assist tool call ID constraints + collision-safe sanitization
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isGoogleModelApi } from "../pi-embedded-helpers.js";
import { repairToolUseResultPairing } from "../session-transcript-repair.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";

function isDeliveryMirrorMessage(message: AgentMessage): boolean {
  return (
    message &&
    typeof message === "object" &&
    (message as { role?: unknown }).role === "assistant" &&
    (message as { model?: unknown }).model === "delivery-mirror" &&
    (message as { provider?: unknown }).provider === "openclaw"
  );
}

function filterDeliveryMirrorMessages(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (isDeliveryMirrorMessage(msg)) {
      touched = true;
      continue;
    }
    out.push(msg);
  }
  return touched ? out : messages;
}

function hasToolCallBlocks(message: AgentMessage): boolean {
  if (!message || typeof message !== "object" || message.role !== "assistant") {
    return false;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const rec = block as { type?: unknown };
    return rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall";
  });
}

function isForeignToolUseMessage(
  message: AgentMessage,
  ctx: { provider?: string | null; modelApi?: string | null },
): boolean {
  if (!hasToolCallBlocks(message)) {
    return false;
  }
  const normalize = (value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase() : "";
  const expectedProvider = normalize(ctx.provider);
  const expectedApi = normalize(ctx.modelApi);
  const msgProvider = normalize((message as { provider?: unknown }).provider);
  const msgApi = normalize((message as { api?: unknown }).api);
  if (expectedProvider && msgProvider && expectedProvider !== msgProvider) {
    return true;
  }
  if (expectedApi && msgApi && expectedApi !== msgApi) {
    return true;
  }
  return false;
}

function filterForeignToolUseMessages(
  messages: AgentMessage[],
  ctx: { provider?: string | null; modelApi?: string | null },
): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (isForeignToolUseMessage(msg, ctx)) {
      touched = true;
      continue;
    }
    out.push(msg);
  }
  return touched ? out : messages;
}

export default function transcriptSanitizeExtension(api: ExtensionAPI): void {
  api.on("context", (event, ctx) => {
    let next = event.messages;
    const withoutDeliveryMirror = filterDeliveryMirrorMessages(next);
    if (withoutDeliveryMirror !== next) {
      next = withoutDeliveryMirror;
    }
    const withoutForeignToolUse = filterForeignToolUseMessages(next, {
      provider: ctx.model?.provider,
      modelApi: ctx.model?.api,
    });
    if (withoutForeignToolUse !== next) {
      next = withoutForeignToolUse;
    }
    const repaired = repairToolUseResultPairing(next);
    if (repaired.messages !== next) {
      next = repaired.messages;
    }
    if (isGoogleModelApi(ctx.model?.api)) {
      const repairedIds = sanitizeToolCallIdsForCloudCodeAssist(next);
      if (repairedIds !== next) {
        next = repairedIds;
      }
    }
    if (next === event.messages) {
      return undefined;
    }
    return { messages: next };
  });
}
