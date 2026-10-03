import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CliSessionBinding, InternalSessionEntry, SessionEntry } from "../config/sessions.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { formatErrorMessageForDisplay } from "../infra/error-diagnostics.js";
import { redactSensitiveText } from "../logging/redact.js";
import { appendAgentRunFailure } from "./agent-run-result.js";
import {
  applyCliSessionBindingResult,
  assertCliSessionBindingResultCommitAllowed,
  clearCliSession,
  getCliSessionBinding,
  setCliSessionBinding,
} from "./cli-session.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

type CliSessionStoreTarget = {
  agentId: string;
  provider: string;
  sessionKey?: string;
  storePath?: string;
  sessionStore?: Record<string, SessionEntry>;
};

async function patchCliSessionBindingInStore(
  params: CliSessionStoreTarget & {
    expectedSession: InternalSessionEntry;
    fallbackEntry?: SessionEntry;
    preserveActivity?: boolean;
    skipMaintenance?: boolean;
    assertCommitAllowed?: () => void;
    update: (entry: SessionEntry) => boolean;
    onCommitted?: () => void;
  },
): Promise<SessionEntry | undefined> {
  const { sessionKey, storePath } = params;
  if (!sessionKey || !storePath) {
    return undefined;
  }
  const expected = { ...params.expectedSession };
  let committed: SessionEntry | undefined;
  await patchSessionEntryCore(
    { agentId: params.agentId, sessionKey, storePath },
    (entry) => {
      // Native ids can survive reset. Publication belongs to the exact local lifecycle/writer.
      if (
        entry.sessionId !== expected.sessionId ||
        entry.lifecycleRevision !== expected.lifecycleRevision ||
        entry.activeWriterRunId !== expected.activeWriterRunId
      ) {
        return null;
      }
      const next = { ...entry };
      if (!params.update(next)) {
        return null;
      }
      return {
        cliSessionIds: next.cliSessionIds,
        cliSessionBindings: next.cliSessionBindings,
        claudeCliSessionId: next.claudeCliSessionId,
      };
    },
    {
      fallbackEntry: params.fallbackEntry,
      assertCommitAllowed: params.assertCommitAllowed,
      preserveActivity: params.preserveActivity,
      skipMaintenance: params.skipMaintenance,
      onCommitted: (entry) => {
        committed = entry;
        params.onCommitted?.();
        if (params.sessionStore) {
          params.sessionStore[sessionKey] = entry;
        }
      },
    },
  );
  return committed;
}

type CliSessionForkStoreParams = Required<CliSessionStoreTarget> & {
  expectedCliSessionId: string;
  assertCommitAllowed?: () => void;
};

async function patchCliSessionForkBinding(
  params: CliSessionForkStoreParams,
  updateBinding: (binding: CliSessionBinding) => CliSessionBinding | undefined,
): Promise<SessionEntry | undefined> {
  const { provider, sessionKey, sessionStore, expectedCliSessionId } = params;
  const entry = sessionStore[sessionKey];
  if (!entry || entry.cliSessionBindings?.[provider]?.sessionId !== expectedCliSessionId) {
    return undefined;
  }
  return await patchCliSessionBindingInStore({
    ...params,
    expectedSession: entry,
    update: (current) => {
      const binding = current.cliSessionBindings?.[provider];
      if (binding?.sessionId !== expectedCliSessionId) {
        return false;
      }
      const nextBinding = updateBinding(binding);
      if (!nextBinding) {
        return false;
      }
      setCliSessionBinding(current, provider, nextBinding);
      return true;
    },
  });
}

/** Clears the one-shot fork marker before the resumed CLI process starts. */
async function consumeCliSessionForkInStore(
  params: CliSessionForkStoreParams,
): Promise<SessionEntry | undefined> {
  return await patchCliSessionForkBinding(params, (binding) => {
    if (binding.forkNextResume !== true) {
      return undefined;
    }
    const { forkNextResume: _forkNextResume, ...consumedBinding } = binding;
    return consumedBinding;
  });
}

/** Arms a fork marker for recovery, or re-arms one after a failed CLI turn. */
export async function restoreCliSessionForkInStore(
  params: CliSessionForkStoreParams,
): Promise<SessionEntry | undefined> {
  return await patchCliSessionForkBinding(params, (binding) =>
    binding.forkNextResume === true ? undefined : { ...binding, forkNextResume: true },
  );
}

/** Share fork publication and cancellation rules across command and live reply callers. */
export function buildCliSessionForkRunParams(
  params: CliSessionForkStoreParams & { abortSignal?: AbortSignal },
  onEntryPatched: (entry: SessionEntry) => void,
): {
  claimCliSessionFork: () => Promise<boolean>;
  restoreCliSessionFork: () => Promise<void>;
  persistCliSessionForkSuccessor: (successorCliSessionId: string) => Promise<void>;
} {
  const activeParams = {
    ...params,
    assertCommitAllowed: () => {
      params.assertCommitAllowed?.();
      params.abortSignal?.throwIfAborted();
    },
  };
  return {
    claimCliSessionFork: async () => {
      const claimed = await consumeCliSessionForkInStore(activeParams);
      if (claimed) {
        onEntryPatched(claimed);
      }
      return Boolean(claimed);
    },
    restoreCliSessionFork: async () => {
      // Cancellation can restore an unspent marker, but a released owner cannot.
      const restored = await restoreCliSessionForkInStore(params);
      if (restored) {
        onEntryPatched(restored);
      }
    },
    persistCliSessionForkSuccessor: async (successorCliSessionId) => {
      const persisted = await persistCliSessionForkSuccessorInStore({
        ...activeParams,
        successorCliSessionId,
      });
      if (!persisted) {
        throw new Error("CLI session fork successor could not be persisted");
      }
      onEntryPatched(persisted);
    },
  };
}

/** Rebinds a claimed fork without bypassing its retained account/environment checks. */
async function persistCliSessionForkSuccessorInStore(
  params: CliSessionForkStoreParams & {
    successorCliSessionId: string;
  },
): Promise<SessionEntry | undefined> {
  if (params.successorCliSessionId === params.expectedCliSessionId) {
    return undefined;
  }
  return await patchCliSessionForkBinding(params, (binding) =>
    binding.forkNextResume === true
      ? undefined
      : { ...binding, sessionId: params.successorCliSessionId },
  );
}

/** A rejected continuity write cannot erase completed effects or reopen model fallback. */
export async function settleCliSessionResult(
  result: EmbeddedAgentRunResult,
  settle: () => Promise<void>,
): Promise<EmbeddedAgentRunResult> {
  try {
    await settle();
    return result;
  } catch (error) {
    const detail = redactSensitiveText(formatErrorMessageForDisplay(error), { mode: "tools" });
    const diagnostic = truncateUtf16Safe(
      `CLI session continuity could not be saved: ${detail}`,
      1_024,
    );
    return appendAgentRunFailure(result, diagnostic);
  }
}

/** Publish native continuity before the placement owner releases its session lane. */
export async function persistCliSessionBindingResult(
  params: CliSessionStoreTarget & {
    result: EmbeddedAgentRunResult;
    expectedSession?: InternalSessionEntry;
    assertSettlementCurrent: () => void;
    abortSignal?: AbortSignal;
  },
): Promise<EmbeddedAgentRunResult> {
  const expectedSession = params.expectedSession;
  if (!expectedSession) {
    return params.result;
  }
  return await settleCliSessionResult(params.result, async () => {
    await patchCliSessionBindingInStore({
      ...params,
      expectedSession,
      preserveActivity: true,
      skipMaintenance: true,
      update: (entry) =>
        applyCliSessionBindingResult(entry, params.provider, params.result.meta.agentMeta),
      assertCommitAllowed: () =>
        assertCliSessionBindingResultCommitAllowed(
          params.result.meta.agentMeta,
          params.assertSettlementCurrent,
          params.abortSignal,
        ),
    });
  });
}

/** Clears a failed/invalid native binding; a turn owner supplies its exact commit guard. */
export async function clearCliSessionInStore(
  params: CliSessionStoreTarget & {
    expectedSessionId?: string;
    expectedCliSessionId?: string;
    activeSessionEntry?: SessionEntry;
    assertCommitAllowed?: () => void;
  },
): Promise<SessionEntry | undefined> {
  const entry =
    params.activeSessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  if (!entry) {
    return undefined;
  }
  const clearEntry = (current: SessionEntry | undefined) => {
    if (
      !current ||
      (params.expectedCliSessionId &&
        getCliSessionBinding(current, params.provider)?.sessionId !== params.expectedCliSessionId)
    ) {
      return false;
    }
    clearCliSession(current, params.provider);
    current.updatedAt = Date.now();
    return true;
  };
  const clearCachedEntries = () => {
    clearEntry(params.activeSessionEntry);
    clearEntry(params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  };
  if (!params.sessionKey || !params.storePath) {
    params.assertCommitAllowed?.();
    clearCachedEntries();
    return undefined;
  }
  return await patchCliSessionBindingInStore({
    ...params,
    expectedSession: { ...entry, sessionId: params.expectedSessionId ?? entry.sessionId },
    // Pre-run compaction can seed its known row; post-run clears never recreate a deleted session.
    fallbackEntry: params.expectedSessionId ? undefined : entry,
    update: clearEntry,
    onCommitted: clearCachedEntries,
  });
}
