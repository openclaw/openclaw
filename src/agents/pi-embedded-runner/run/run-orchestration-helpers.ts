// Pure orchestration helpers extracted from `run.ts` so the embedded run
// orchestrator does not own auth-store seeding, trace-summary shaping,
// session-key backfill, or handled-reply payload normalization.
//
// This is one piece of the run-orchestration extraction for RFC 72072. The
// companion modules `model-auth-plan.ts`, `runtime-plan-factory.ts`,
// `lane-workspace.ts`, and `terminal-result.ts` keep the top-level runner as
// the table-of-contents entrypoint while preserving the existing runtime flow.
//
// The exported helpers are pure or close-to-pure:
//   - `createEmptyAuthProfileStore` returns a fresh AuthProfileStore.
//   - `buildTraceToolSummary` aggregates a tool-call slice into the trace
//     summary shape used by the run-attempt observability pipeline.
//   - `backfillSessionKey` does the read-only sessionId→sessionKey lookup
//     that runs at the top of `runEmbeddedPiAgent`. It logs a warning on
//     failure but otherwise has no side effects.
//   - `buildHandledReplyPayloads` preserves a handled ReplyPayload's full
//     shape while normalising a missing reply into the array shape downstream
//     delivery expects.

import type { ReplyPayload } from "../../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import {
  resolveSessionKeyForRequest,
  resolveStoredSessionKeyForSessionId,
} from "../../command/session.js";
import { redactRunIdentifier } from "../../workspace-run.js";
import { log } from "../logger.js";
import type { ToolSummaryTrace } from "../types.js";
import type { RunEmbeddedPiAgentParams } from "./params.js";

export function createEmptyAuthProfileStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {},
  };
}

export function buildTraceToolSummary(params: {
  toolMetas: Array<{ toolName: string; meta?: string }>;
  hadFailure: boolean;
}): ToolSummaryTrace | undefined {
  if (params.toolMetas.length === 0) {
    return undefined;
  }
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const entry of params.toolMetas) {
    const toolName = normalizeOptionalString(entry.toolName);
    if (!toolName || seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);
    tools.push(toolName);
  }
  return {
    calls: params.toolMetas.length,
    tools,
    failures: params.hadFailure ? 1 : 0,
  };
}

/**
 * Best-effort backfill of sessionKey from sessionId when not explicitly provided.
 * The return value is normalized: whitespace-only inputs collapse to undefined, and
 * successful resolution returns a trimmed session key. This is a read-only lookup
 * with no side effects.
 * See: https://github.com/openclaw/openclaw/issues/60552
 */
export function backfillSessionKey(params: {
  config: RunEmbeddedPiAgentParams["config"];
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  const trimmed = normalizeOptionalString(params.sessionKey);
  if (trimmed) {
    return trimmed;
  }
  if (!params.config || !params.sessionId) {
    return undefined;
  }
  try {
    const resolved = normalizeOptionalString(params.agentId)
      ? resolveStoredSessionKeyForSessionId({
          cfg: params.config,
          sessionId: params.sessionId,
          agentId: params.agentId,
        })
      : resolveSessionKeyForRequest({
          cfg: params.config,
          sessionId: params.sessionId,
        });
    return normalizeOptionalString(resolved.sessionKey);
  } catch (err) {
    log.warn(
      `[backfillSessionKey] Failed to resolve sessionKey for sessionId=${redactRunIdentifier(sanitizeForLog(params.sessionId))}: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

export function buildHandledReplyPayloads(reply?: ReplyPayload) {
  return [reply ?? { text: SILENT_REPLY_TOKEN }];
}
