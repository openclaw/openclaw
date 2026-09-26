import {
  embeddedAgentLog,
  type CompactEmbeddedAgentSessionParams,
  type EmbeddedAgentCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { JsonObject } from "./protocol.js";

export function codexNativeCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  outcome: { compacted: boolean; reason?: string; tokensAfter?: number; details: JsonObject },
): EmbeddedAgentCompactResult {
  return {
    ok: true,
    compacted: outcome.compacted,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: params.currentTokenCount ?? 0,
      ...(outcome.tokensAfter !== undefined ? { tokensAfter: outcome.tokensAfter } : {}),
      details: outcome.details,
    },
  };
}

export function skippedCodexNativeCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  skipped: {
    reason: string;
    code: string;
    request?: "required_preflight" | "after_context_engine";
    expectedThreadId?: string;
    currentThreadId?: string;
  },
): EmbeddedAgentCompactResult {
  return codexNativeCompactionResult(params, {
    compacted: false,
    reason: skipped.reason,
    details: {
      backend: "codex-app-server",
      skipped: true,
      reason: skipped.code,
      request: skipped.request ?? "after_context_engine",
      trigger: params.trigger ?? "unknown",
      ...(skipped.expectedThreadId ? { expectedThreadId: skipped.expectedThreadId } : {}),
      ...(skipped.currentThreadId ? { currentThreadId: skipped.currentThreadId } : {}),
    },
  });
}

export function failedCodexThreadBindingCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  recovery: {
    reason: string;
    recovery: "missing_thread_binding" | "stale_thread_binding";
    threadId?: string;
  },
): EmbeddedAgentCompactResult {
  embeddedAgentLog.warn("codex app-server compaction could not use thread binding", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    threadId: recovery.threadId,
    reason: recovery.reason,
    recovery: recovery.recovery,
  });
  return {
    ok: false,
    compacted: false,
    reason: recovery.reason,
    failure: {
      reason: recovery.recovery,
      rawError: recovery.reason,
    },
  };
}
