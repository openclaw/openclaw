import {
  AgentHarnessSessionSupersededError,
  embeddedAgentLog,
  type AgentHarnessCompactParams,
  type CompactEmbeddedAgentSessionParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  retainCodexAppServerLiveThread,
  revertCodexAppServerLiveThreadInstructions,
} from "./client-runtime.js";
import type { CodexAppServerLiveThreadOwnership } from "./client-thread-owner.js";
import type { CodexAppServerClient } from "./client.js";
import { resolveCodexNativeExecutionBlock } from "./sandbox-guard.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
  CodexBindingAuthority,
} from "./session-binding.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";

/** Settles the consumed subscription without returning stale ownership to the next turn. */
export async function settleCodexCompactionSubscription(params: {
  client: CodexAppServerClient;
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  binding: CodexAppServerThreadBinding;
  authority: CodexBindingAuthority;
  ownership?: CodexAppServerLiveThreadOwnership;
  compacted: boolean;
  release?: () => Promise<void>;
}): Promise<void> {
  let retained = false;
  try {
    if (params.compacted) {
      // Incognito keeps a separately owned subscription. Revert its discarded refresh
      // in place so the next turn redelivers the current instructions.
      await params.authority.withCurrent(() =>
        revertCodexAppServerLiveThreadInstructions(params.client, params.binding.threadId),
      );
    }
    const ownership = params.ownership;
    if (ownership) {
      // Reset uses the same generation lease; publication also needs fresh lineage.
      retained = await params.bindingStore.withLease(
        params.identity,
        async () => {
          let pendingRetention: Promise<boolean> | undefined;
          try {
            await params.authority.withCurrent(() => {
              if (
                !isSameCodexAppServerThreadOwner(
                  params.bindingStore.read(params.identity),
                  params.binding,
                )
              ) {
                return;
              }
              // Publication is synchronous; idle eviction settles outside the read grant.
              pendingRetention = retainCodexAppServerLiveThread(
                params.client,
                params.binding.threadId,
                ownership.release,
                ownership.configFingerprint,
                ownership.serviceTier,
                // Native compaction restores creation-time instructions, not the injected refresh.
                ownership.ephemeralPolicy && params.compacted
                  ? {
                      ...ownership.ephemeralPolicy,
                      refreshableInstructions:
                        ownership.ephemeralPolicy.nativeRefreshableInstructions,
                    }
                  : ownership.ephemeralPolicy,
              );
            });
          } catch (error) {
            // Reader release can fail after publication. Join eviction before cleanup;
            // never replay publication or preserve a claim from a rejected authority scope.
            await pendingRetention;
            throw error;
          }
          return pendingRetention ? await pendingRetention : false;
        },
        { authority: params.authority },
      );
    }
  } catch (error) {
    // A replaced generation may settle native work, but cannot republish its owner.
    if (!(error instanceof AgentHarnessSessionSupersededError)) {
      throw error;
    }
  } finally {
    if (!retained) {
      await params.release?.();
    }
  }
}

export async function clearContextEngineProjectionBeforeNativeCompaction(params: {
  sessionId: string;
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  binding: CodexAppServerThreadBinding;
  assertCurrent: () => void;
  authority: CodexBindingAuthority;
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
    params.authority,
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
  const compaction = asOptionalRecord(params.config?.agents?.defaults?.compaction);
  const ignoredConfig = ["model", "thinkingLevel", "provider"].flatMap((field) => {
    const value = compaction?.[field];
    return typeof value === "string" && value.trim() ? [`agents.defaults.compaction.${field}`] : [];
  });
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

export function resolveCodexCompactionExecutionBlock(
  params: AgentHarnessCompactParams<2> & { sandbox?: SandboxContext | null },
) {
  return resolveCodexNativeExecutionBlock({
    config: params.config,
    sessionKey: params.sandboxSessionKey ?? params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.sandboxAgentId ?? params.agentId,
    sandbox: params.sandbox,
    surface: "native compaction",
  });
}
