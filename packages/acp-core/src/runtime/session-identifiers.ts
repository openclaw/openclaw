import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString as normalizeText,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionAcpIdentity, SessionAcpMeta } from "../types.js";
import { isSessionIdentityPending, resolveSessionIdentityFromMeta } from "./session-identity.js";

export const ACP_SESSION_IDENTITY_RENDERER_VERSION = "v1";
export type AcpSessionIdentifierRenderMode = "status" | "thread";

const ACP_AGENT_RESUME_COMMAND_BY_KEY = new Map<string, "codex" | "kimi">([
  ["codex", "codex"],
  ["openai", "codex"],
  ["codex-cli", "codex"],
  ["kimi", "kimi"],
  ["moonshot-kimi", "kimi"],
]);

function normalizeAgentHintKey(value: unknown): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) {
    return undefined;
  }
  return normalizeLowercaseStringOrEmpty(normalized).replace(/[\s_]+/g, "-");
}

function resolveAcpAgentResumeHintLine(params: {
  agentId?: string;
  agentSessionId?: string;
}): string | undefined {
  const agentSessionId = normalizeText(params.agentSessionId);
  const agentKey = normalizeAgentHintKey(params.agentId);
  if (!agentSessionId || !agentKey) {
    return undefined;
  }
  const command = ACP_AGENT_RESUME_COMMAND_BY_KEY.get(agentKey);
  if (!command) {
    return undefined;
  }
  const label = command === "codex" ? "Codex" : "Kimi";
  return `resume in ${label} CLI: \`${command} resume ${agentSessionId}\` (continues this conversation).`;
}

/** Renders resolved ACP backend/agent ids, hiding pending ids from thread intros. */
export function resolveAcpSessionIdentifierLinesFromIdentity(params: {
  backend: string;
  identity?: SessionAcpIdentity;
  mode?: AcpSessionIdentifierRenderMode;
}): string[] {
  const backend = normalizeText(params.backend) ?? "backend";
  const mode = params.mode ?? "status";
  const identity = params.identity;
  const agentSessionId = normalizeText(identity?.agentSessionId);
  const acpxSessionId = normalizeText(identity?.acpxSessionId);
  const acpxRecordId = normalizeText(identity?.acpxRecordId);
  const hasIdentifier = Boolean(agentSessionId || acpxSessionId || acpxRecordId);
  if (isSessionIdentityPending(identity) && hasIdentifier) {
    // Status views explain that ids are still settling; thread intros stay quiet so
    // users do not copy provisional backend ids before the first reply resolves them.
    if (mode === "status") {
      return ["session ids: pending (available after the first reply)"];
    }
    return [];
  }
  const lines: string[] = [];
  if (agentSessionId) {
    lines.push(`agent session id: ${agentSessionId}`);
  }
  if (acpxSessionId) {
    lines.push(`${backend} session id: ${acpxSessionId}`);
  }
  if (acpxRecordId) {
    lines.push(`${backend} record id: ${acpxRecordId}`);
  }
  return lines;
}

/** Resolves the runtime cwd, preferring modern runtimeOptions over legacy metadata. */
export function resolveAcpSessionCwd(meta?: SessionAcpMeta): string | undefined {
  return normalizeText(meta?.runtimeOptions?.cwd) ?? normalizeText(meta?.cwd);
}

/** Renders thread-detail identifier lines plus a backend-specific resume hint when stable. */
export function resolveAcpThreadSessionDetailLines(params: {
  sessionKey: string;
  meta?: SessionAcpMeta;
}): string[] {
  const meta = params.meta;
  const identity = resolveSessionIdentityFromMeta(meta);
  const backend = normalizeText(meta?.backend) ?? "backend";
  const lines = resolveAcpSessionIdentifierLinesFromIdentity({
    backend,
    identity,
    mode: "thread",
  });
  if (lines.length === 0) {
    return lines;
  }
  const hint = resolveAcpAgentResumeHintLine({
    agentId: meta?.agent,
    agentSessionId: identity?.agentSessionId,
  });
  if (hint) {
    lines.push(hint);
  }
  return lines;
}
