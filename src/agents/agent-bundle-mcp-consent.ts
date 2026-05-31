import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logWarn } from "../logger.js";
import { isPlainObject } from "../utils.js";
import { callGatewayTool } from "./tools/gateway.js";

/**
 * MCP "consent envelope" — a standard response shape MCP servers can return
 * from any tool that wants user approval before mutating state.
 *
 * Shape (top-level in `structuredContent`, or JSON-parseable from
 * `content[0].text`):
 *
 *   {
 *     "ok": false,
 *     "requires_confirmation": true,
 *     "action_id": "<server-side single-use token>",
 *     "summary": "<short user-readable description of what the tool will do>",
 *     "expires_in_seconds": 60   // optional, server-side TTL hint
 *   }
 *
 * When OpenClaw sees this envelope it does NOT pass the result back to the
 * model. Instead it issues a plugin-style approval through the gateway,
 * blocks until the user replies `/approve <id> allow-once|deny`
 * on the trusted channel, and on approval re-calls the same MCP tool with
 * `confirmation_token` set to `action_id`. The model never sees `action_id`
 * — so it cannot self-approve by echoing the token back. This moves the
 * trust boundary from "model behaves" to "verified channel reply."
 *
 * Servers that don't speak the envelope are unchanged: their results pass
 * through verbatim.
 */
export type McpConsentEnvelope = {
  actionId: string;
  summary: string;
  expiresInSeconds?: number;
};

/** Parse an MCP CallToolResult for the consent envelope. Returns null if
 *  the result is a normal tool response. */
export function detectMcpConsentEnvelope(result: CallToolResult): McpConsentEnvelope | null {
  // Prefer structuredContent — that's the MCP-spec'd typed slot.
  const structured = result.structuredContent;
  if (structured && isPlainObject(structured)) {
    const env = parseEnvelopeRecord(structured);
    if (env) {
      return env;
    }
  }
  // Fall back to JSON-parsing content[0].text — what most stdio MCP
  // servers do today, including HomeBrain's reference servers.
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const blockObj = block as { type?: unknown; text?: unknown };
    if (blockObj.type !== "text" || typeof blockObj.text !== "string") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(blockObj.text);
    } catch {
      continue;
    }
    if (parsed && isPlainObject(parsed)) {
      const env = parseEnvelopeRecord(parsed);
      if (env) {
        return env;
      }
    }
  }
  return null;
}

/** Neutralise any parser-shaped `approve` substring in tool-emitted text
 *  so a compromised MCP server can't smuggle an authoritative-looking
 *  approval command into the chat transcript via the consent prompt's
 *  `summary` field (or any other string we propagate verbatim from the
 *  envelope). The parser (`commands-approve.ts`) anchors at
 *  `/^\/?approve(?:\s|$)/i` — the slash is optional — so both `/approve`
 *  and bare `approve` are entry points and both must be defanged.
 *
 *  Injects U+200B (zero-width space) immediately before `approve` so the
 *  parser anchor never matches, while keeping the text human-readable.
 *  Only matches at line start or after whitespace (the parser's effective
 *  anchor after trimming) to avoid mangling prose like "preapproved" or
 *  "she /approves the plan".
 *
 *  This is defence-in-depth, not the primary defence. The primary
 *  defence is that `action_id` is never sent to the model and
 *  `confirmation_token` is scrubbed from model-supplied input, so the
 *  model cannot self-approve even if it could emit `/approve`-shaped
 *  text. ZWSP-splitting closes a hypothetical regression where a future
 *  renderer (re-)parses approval commands from tool-emitted strings,
 *  e.g. a self-message echo or a transcript-replay feature.
 *
 *  Normalisation: U+200B is stable under NFC (the form chat layers
 *  use). It IS decomposed under NFKC; if a downstream renderer applies
 *  NFKC the protection vanishes — track if that ever changes. The
 *  defence here is layer-appropriate, not a security boundary. */
const APPROVE_COMMAND_RE = /(^|\s)(\/?)approve\b/gim;
const ZWSP = "​";

export function sanitiseToolEmittedApprovalText(text: string): string {
  return text.replace(APPROVE_COMMAND_RE, `$1$2${ZWSP}approve`);
}

function parseEnvelopeRecord(record: Record<string, unknown>): McpConsentEnvelope | null {
  if (record.requires_confirmation !== true) {
    return null;
  }
  const actionId = typeof record.action_id === "string" ? record.action_id.trim() : "";
  if (!actionId) {
    return null;
  }
  const rawSummary =
    typeof record.summary === "string" && record.summary.trim().length > 0
      ? record.summary.trim()
      : "An MCP tool requires user approval.";
  const summary = sanitiseToolEmittedApprovalText(rawSummary);
  const ttl =
    typeof record.expires_in_seconds === "number" && Number.isFinite(record.expires_in_seconds)
      ? Math.max(1, Math.floor(record.expires_in_seconds))
      : undefined;
  return {
    actionId,
    summary,
    expiresInSeconds: ttl,
  };
}

/** The decision returned by the gateway approval flow. Mirrors
 *  ExecApprovalDecision so it slots into the existing `/approve` parser. */
export type McpConsentDecision = "allow-once" | "allow-always" | "deny";

export type McpConsentApprovalContext = {
  serverName: string;
  toolName: string;
  /** The materialized agent-tool name (e.g. `homebrain-nextcloud__nc-files_share`). */
  agentToolName: string;
  /** Optional — the agent harness's tool call id for traceability. */
  toolCallId?: string;
  /** Optional — agent + session metadata for the channel runtime. */
  agentId?: string;
  sessionKey?: string;
  /** The channel that originated the agent turn (e.g. "whatsapp", "telegram"). */
  channel?: string;
  /** The target within the channel (e.g. phone number, chat ID). */
  channelTarget?: string;
};

export type RequestMcpConsentApproval = (params: {
  envelope: McpConsentEnvelope;
  ctx: McpConsentApprovalContext;
  /** Fallback timeout when the envelope omits `expires_in_seconds`.
   *  Capped at MAX_CONSENT_TIMEOUT_MS regardless. Optional —
   *  DEFAULT_CONSENT_TIMEOUT_MS applies when omitted. */
  defaultTimeoutMs?: number;
  signal?: AbortSignal;
}) => Promise<McpConsentDecision | "unavailable" | "expired">;

/** Fallback wait window when the MCP envelope omits a TTL. Calibrated
 *  for mobile reply channels (WhatsApp/Telegram/SMS) where notification
 *  → unlock → context → tap is realistically 60–180s. 2 min is too
 *  tight; 10 min is the hard cap (see MAX). Override per-deployment via
 *  `mcp.approvals.defaultTimeoutMs`. */
export const DEFAULT_CONSENT_TIMEOUT_MS = 300_000;
/** Hard cap on the wait window — applies to both the default fallback
 *  and any envelope-supplied `expires_in_seconds`. Anything longer is
 *  a UX failure (the user has long since abandoned the prompt). */
export const MAX_CONSENT_TIMEOUT_MS = 600_000;

/** Default approval requester — talks to the local gateway via
 *  `plugin.approval.request` + `plugin.approval.waitDecision`. Reuses the
 *  existing plugin-approval pipeline (gateway storage, channel delivery,
 *  `/approve <id>` reply parser, ID-prefix routing). */
export const defaultRequestMcpConsentApproval: RequestMcpConsentApproval = async ({
  envelope,
  ctx,
  defaultTimeoutMs,
  signal,
}) => {
  // Fallback when the envelope omits TTL: caller-provided (from config)
  // or the package default. Envelope-supplied TTLs and the fallback are
  // both clamped to MAX_CONSENT_TIMEOUT_MS — see constant docs above.
  const fallbackMs = Math.min(
    Math.max(defaultTimeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS, 1000),
    MAX_CONSENT_TIMEOUT_MS,
  );
  const timeoutMs = envelope.expiresInSeconds
    ? Math.min(envelope.expiresInSeconds * 1000, MAX_CONSENT_TIMEOUT_MS)
    : fallbackMs;
  const safeToolName = sanitiseToolEmittedApprovalText(ctx.toolName);
  const rawDescription = `${ctx.serverName}.${safeToolName} — ${envelope.summary}`;
  const description =
    rawDescription.length > 256 ? rawDescription.slice(0, 253) + "…" : rawDescription;
  const turnSourceChannel = ctx.channel || undefined;
  const turnSourceTo = ctx.channelTarget || undefined;

  let requestResult: { id?: string; decision?: string | null } | undefined;
  try {
    requestResult = await callGatewayTool<{ id?: string; decision?: string | null }>(
      "plugin.approval.request",
      { timeoutMs: timeoutMs + 10_000 },
      {
        pluginId: `mcp:${ctx.serverName}`,
        title: "MCP tool approval",
        description,
        severity: "warning",
        toolName: ctx.agentToolName,
        toolCallId: ctx.toolCallId,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        turnSourceChannel,
        turnSourceTo,
        // MCP consent has no durable per-tool allow store: callMcpToolWithConsent
        // treats any non-deny approval as a single re-call. Only offer decisions
        // that match that one-shot behavior (and the documented allow-once|deny
        // contract) — never allow-always, which would imply a persistence the
        // gateway here cannot honor.
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs,
        twoPhase: true,
      },
      { expectFinal: false },
    );
  } catch (err) {
    logWarn(`bundle-mcp consent: gateway approval request failed: ${String(err)}`);
    return "unavailable";
  }
  const id = requestResult?.id;
  if (!id) {
    return "unavailable";
  }
  // Distinguish three immediate-decision shapes from the gateway:
  //   - `decision` key absent: accepted two-phase request — fall through
  //     to waitDecision.
  //   - `decision: null`: gateway expired the request because no approval
  //     route exists (see src/gateway/server-methods/approval-shared.ts).
  //     Don't wait on an already-expired id; surface "unavailable" so the
  //     caller can build a no-route denied result rather than a generic
  //     user-denial result. Mirrors src/agents/agent-tools.before-tool-call.ts.
  //   - any other value: immediate decision — normalize and return.
  const hasImmediate = requestResult !== undefined && "decision" in requestResult;
  const immediate = requestResult?.decision;
  if (hasImmediate && immediate === null) {
    logWarn(
      `bundle-mcp consent: gateway returned no-route for ${ctx.serverName}.${ctx.toolName} (no approval delivery channel for this request)`,
    );
    return "unavailable";
  }
  if (immediate !== undefined && immediate !== null) {
    return normalizeDecision(immediate);
  }
  const waitPromise = callGatewayTool<{ id?: string; decision?: string | null }>(
    "plugin.approval.waitDecision",
    { timeoutMs: timeoutMs + 10_000 },
    { id },
  );
  let waitResult: { id?: string; decision?: string | null } | undefined;
  try {
    if (signal) {
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          return;
        }
        onAbort = () =>
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        waitResult = await Promise.race([waitPromise, abortPromise]);
      } finally {
        if (onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    } else {
      waitResult = await waitPromise;
    }
  } catch (err) {
    logWarn(`bundle-mcp consent: gateway waitDecision failed: ${String(err)}`);
    return "unavailable";
  }
  // No decision after the wait → the approval expired without a user
  // reply. Distinguish this from an explicit deny so audit logs and the
  // synthetic tool result say "timed out" rather than "user declined".
  const finalDecision = waitResult?.decision;
  if (finalDecision === undefined || finalDecision === null) {
    return "expired";
  }
  return normalizeDecision(finalDecision);
};

function normalizeDecision(value: unknown): McpConsentDecision {
  if (value === "allow-once" || value === "allow-always" || value === "deny") {
    return value;
  }
  return "deny";
}

/** Strip `confirmation_token` from a model-supplied tool input. Defence
 *  against the model trying to fabricate a token: only the consent path
 *  is allowed to set it. */
export function scrubModelSuppliedConfirmationToken(input: unknown): {
  cleaned: unknown;
  stripped: boolean;
} {
  if (!isPlainObject(input)) {
    return { cleaned: input, stripped: false };
  }
  if (!("confirmation_token" in input)) {
    return { cleaned: input, stripped: false };
  }
  const { confirmation_token: _ignored, ...rest } = input;
  return { cleaned: rest, stripped: true };
}

/** A synthetic CallToolResult communicating that the user denied the
 *  approval, or that the approval system was unavailable / expired. The
 *  model receives this — it never sees the original `action_id`. */
export function buildConsentDeniedResult(params: {
  envelope: McpConsentEnvelope;
  decision: McpConsentDecision | "expired" | "error";
  serverName: string;
  toolName: string;
}): CallToolResult {
  const reason = (() => {
    switch (params.decision) {
      case "deny":
        return "User declined the approval.";
      case "expired":
        return "Approval timed out before the user responded.";
      case "error":
        return "Approval system was unavailable.";
      default:
        return "Approval not granted.";
    }
  })();
  const text = JSON.stringify({
    ok: false,
    approved: false,
    reason,
    summary: params.envelope.summary,
    server: params.serverName,
    tool: params.toolName,
  });
  return {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: {
      ok: false,
      approved: false,
      reason,
    },
  };
}
