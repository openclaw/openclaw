import {
  embeddedAgentLog,
  type CompactEmbeddedAgentSessionParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
} from "./session-binding.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";

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

// ttlMs: 0 retains keys until the 4,096-entry LRU cap evicts them, after which a
// previously suppressed warning can intentionally emit again.
const warnedIgnoredCompactionOverrides = createDedupeCache({ ttlMs: 0, maxSize: 4096 });

export function warnIfIgnoringOpenClawCompactionOverrides(
  params: CompactEmbeddedAgentSessionParams,
): void {
  const ignoredConfig = readIgnoredCompactionOverridePaths(params);
  if (ignoredConfig.length === 0) {
    return;
  }
  const warningKey = ignoredConfig.join("\0");
  if (warnedIgnoredCompactionOverrides.check(warningKey)) {
    return;
  }
  embeddedAgentLog.warn(
    "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ignoredConfig,
    },
  );
}

function readIgnoredCompactionOverridePaths(params: CompactEmbeddedAgentSessionParams): string[] {
  const compaction = asOptionalRecord(params.config?.agents?.defaults?.compaction);
  return ["model", "thinkingLevel", "provider"].flatMap((field) => {
    const value = compaction?.[field];
    return typeof value === "string" && value.trim() ? [`agents.defaults.compaction.${field}`] : [];
  });
}
