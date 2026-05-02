import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { replyToZekeProposal, ZekeFlowClientError } from "./client.js";
import { resolveZekePluginConfig } from "./config.js";

function looksLikeProposalDecision(text: string): boolean {
  const trimmed = text.trim();
  return /^(?:y|yes|n|no)$/iu.test(trimmed) || /^edit\s*:/iu.test(trimmed);
}

export async function handleOpenClawProposalReply(
  api: OpenClawPluginApi,
  event: { content?: unknown; body?: unknown; sessionKey?: string },
  ctx: { sessionKey?: string },
): Promise<{ handled: boolean; text?: string } | void> {
  const config = resolveZekePluginConfig(api);
  if (config.profile !== "sprout") return undefined;

  const text = String(event.content || event.body || "").trim();
  if (!looksLikeProposalDecision(text)) return undefined;

  try {
    const result = await replyToZekeProposal(config, {
      text,
      sessionKey: event.sessionKey || ctx.sessionKey,
      operatorId: config.operatorId,
    });
    const action = (result as { result?: { action?: unknown; message?: unknown } })?.result?.action;
    if (!action || action === "none") return undefined;
    const message = (result as { result?: { message?: unknown } })?.result?.message;
    return {
      handled: true,
      text: typeof message === "string" ? message : "Proposal reply recorded.",
    };
  } catch (error) {
    if (error instanceof ZekeFlowClientError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}
