// Msteams plugin module: audit log channel (#15).
//
// Mirrors a compact, DLP-redacted line of each agent reply to a configured Teams "audit" conversation
// so admins have a governance trail of what the bot said and to whom — without reading every session
// file. Pure helpers here (resolve target + format the line); the wiring (fire a mirror after each
// reply) lives in reply-dispatcher.ts. Off unless channels.msteams.auditChannel is set.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { redactOutboundMSTeamsText } from "./dlp.js";

/**
 * Resolve the audit conversation to mirror to, or null when auditing is off or the source IS the
 * audit channel (the loop guard — never mirror the audit channel's own traffic back into itself).
 */
export function resolveMSTeamsAuditTarget(
  cfg: OpenClawConfig,
  sourceConversationId: string | undefined,
): string | null {
  const auditChannel = cfg.channels?.msteams?.auditChannel?.trim();
  if (!auditChannel) {
    return null;
  }
  // The audit `to` may be prefixed ("conversation:19:..."); compare against the bare id too.
  const bare = auditChannel.replace(/^conversation:/, "");
  if (
    sourceConversationId &&
    (sourceConversationId === auditChannel || sourceConversationId === bare)
  ) {
    return null;
  }
  return auditChannel;
}

/** Cap the mirrored excerpt so the audit channel stays a readable trail, not a full transcript. */
const MAX_EXCERPT = 600;

/**
 * Build the compact audit line for one agent reply. Identifies the source conversation and (when
 * known) the person who prompted it, then a single-line excerpt of the reply. Redacts BEFORE
 * truncating: the excerpt cap could otherwise cut a secret mid-match, leaving a fragment the
 * downstream send-path redaction no longer recognizes — a partial secret in the audit trail.
 */
export function buildMSTeamsAuditLine(params: {
  cfg: OpenClawConfig;
  sourceConversationId?: string;
  senderName?: string;
  text: string;
}): string {
  const who = params.senderName?.trim() ? ` for ${params.senderName.trim()}` : "";
  const where = params.sourceConversationId ? ` in ${params.sourceConversationId}` : "";
  const scrubbed = redactOutboundMSTeamsText(params.text, params.cfg);
  const excerpt = scrubbed.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT);
  return `🧾 Reply${who}${where}:\n${excerpt}`;
}
