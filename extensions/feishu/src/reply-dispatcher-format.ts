import type { OutboundIdentity } from "../runtime-api.js";
import { resolveFeishuIdentityEmoji } from "./identity-header.js";
import type { CardHeaderConfig } from "./send.js";

export function mergeStreamingFinalText(
  previousText: string,
  nextText: string,
  appendError: boolean,
): string {
  if (!appendError || !previousText || nextText.startsWith(previousText)) {
    return nextText;
  }
  if (previousText.endsWith(`\n\n${nextText}`)) {
    return previousText;
  }
  return `${previousText}\n\n${nextText}`;
}

export function resolveCardHeader(
  agentId: string,
  identity: OutboundIdentity | undefined,
): CardHeaderConfig | undefined {
  const name = identity?.name?.trim() || (agentId === "main" ? "" : agentId);
  const emoji = resolveFeishuIdentityEmoji(identity?.emoji);
  const title = (emoji ? `${emoji} ${name}` : name).trim();
  if (!title) {
    return undefined;
  }
  return {
    title,
    template: identity?.theme ?? "blue",
  };
}

export function resolveCardNote(
  agentId: string,
  identity: OutboundIdentity | undefined,
  prefixCtx: { model?: string; provider?: string },
): string {
  const name = identity?.name?.trim() || agentId;
  const parts: string[] = [`Agent: ${name}`];
  if (prefixCtx.model) {
    parts.push(`Model: ${prefixCtx.model}`);
  }
  if (prefixCtx.provider) {
    parts.push(`Provider: ${prefixCtx.provider}`);
  }
  return parts.join(" | ");
}
