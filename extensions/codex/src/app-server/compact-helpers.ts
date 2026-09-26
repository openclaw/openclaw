import {
  embeddedAgentLog,
  type CompactEmbeddedAgentSessionParams,
  type EmbeddedAgentCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { JsonObject } from "./protocol.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
} from "./session-binding.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";

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

export async function clearContextEngineProjectionBeforeNativeCompaction(params: {
  sessionId: string;
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  binding: CodexAppServerThreadBinding;
  assertCurrent: () => void;
}): Promise<void> {
  const contextEngineBinding = params.binding.contextEngine;
  if (!contextEngineBinding?.projection) {
    return;
  }
  // Native Codex compaction mutates the thread history outside the projection
  // guard. Clear only the projection marker so the next turn reprojects context.
  await params.bindingStore.mutate(
    params.identity,
    {
      kind: "patch",
      threadId: params.binding.threadId,
      patch: {
        contextEngine: {
          ...contextEngineBinding,
          projection: undefined,
        },
      },
    },
    params.assertCurrent,
  );
  embeddedAgentLog.info("cleared codex context-engine projection before native compaction", {
    sessionId: params.sessionId,
    threadId: params.binding.threadId,
    previousEpoch: contextEngineBinding.projection.epoch,
    previousFingerprint: contextEngineBinding.projection.fingerprint,
  });
}

export function isSameNativeCompactionBinding(
  current: CodexAppServerThreadBinding,
  expected: CodexAppServerThreadBinding,
): boolean {
  return (
    isSameCodexAppServerThreadOwner(current, expected) &&
    current.authProfileId === expected.authProfileId &&
    current.contextEngine?.engineId === expected.contextEngine?.engineId &&
    current.contextEngine?.policyFingerprint === expected.contextEngine?.policyFingerprint &&
    current.contextEngine?.projection?.mode === expected.contextEngine?.projection?.mode &&
    current.contextEngine?.projection?.epoch === expected.contextEngine?.projection?.epoch &&
    current.contextEngine?.projection?.fingerprint ===
      expected.contextEngine?.projection?.fingerprint
  );
}

export function isCodexThreadNotFoundError(error: unknown): boolean {
  // codex-rs exposes no dedicated error code for a missing compaction thread:
  // thread/compact/start returns generic INVALID_REQUEST (-32600), and the
  // app-server's own contract/test asserts the "thread not found" MESSAGE as
  // the discriminator (thread_processor.rs load_thread → invalid_request;
  // compaction.rs asserts message.contains("thread not found")). So the message
  // gates recovery, not user-facing classification; the generic code is ambiguous.
  return coerceErrorMessage(error).toLowerCase().includes("thread not found");
}
