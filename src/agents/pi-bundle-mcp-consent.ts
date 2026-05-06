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
 * blocks until the user replies `/approve <id> allow-once|allow-always|deny`
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

function parseEnvelopeRecord(record: Record<string, unknown>): McpConsentEnvelope | null {
  if (record.requires_confirmation !== true) {
    return null;
  }
  const actionId = typeof record.action_id === "string" ? record.action_id.trim() : "";
  if (!actionId) {
    return null;
  }
  const summary =
    typeof record.summary === "string" && record.summary.trim().length > 0
      ? record.summary.trim()
      : "An MCP tool requires user approval.";
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
};

export type RequestMcpConsentApproval = (params: {
  envelope: McpConsentEnvelope;
  ctx: McpConsentApprovalContext;
}) => Promise<McpConsentDecision>;

/** Default approval requester — talks to the local gateway via
 *  `plugin.approval.request` + `plugin.approval.waitDecision`. Reuses the
 *  existing plugin-approval pipeline (gateway storage, channel delivery,
 *  `/approve <id>` reply parser, ID-prefix routing). */
export const defaultRequestMcpConsentApproval: RequestMcpConsentApproval = async ({
  envelope,
  ctx,
}) => {
  const timeoutMs = envelope.expiresInSeconds
    ? Math.min(envelope.expiresInSeconds * 1000, 600_000)
    : 120_000;
  const description = `${ctx.serverName}.${ctx.toolName} — ${envelope.summary}`;
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
        timeoutMs,
        twoPhase: true,
      },
      { expectFinal: false },
    );
  } catch (err) {
    logWarn(`bundle-mcp consent: gateway approval request failed: ${String(err)}`);
    return "deny";
  }
  const id = requestResult?.id;
  if (!id) {
    return "deny";
  }
  if (
    Object.prototype.hasOwnProperty.call(requestResult ?? {}, "decision") &&
    requestResult?.decision !== undefined
  ) {
    return normalizeDecision(requestResult.decision);
  }
  let waitResult: { id?: string; decision?: string | null } | undefined;
  try {
    waitResult = await callGatewayTool<{ id?: string; decision?: string | null }>(
      "plugin.approval.waitDecision",
      { timeoutMs: timeoutMs + 10_000 },
      { id },
    );
  } catch (err) {
    logWarn(`bundle-mcp consent: gateway waitDecision failed: ${String(err)}`);
    return "deny";
  }
  return normalizeDecision(waitResult?.decision);
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
  const { confirmation_token: _ignored, ...rest } = input as Record<string, unknown>;
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
