import { vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import type {
  listSessionEntriesCore,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import type {
  SessionIdentityMutation,
  SessionIdentityMutationListener,
} from "../../../sessions/session-lifecycle-events.js";
import { notifyListeners, registerListener } from "../../../shared/listeners.js";
import type {
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const noop = () => {};

export function createSubagentRegistryMockState() {
  const sessionIdentityMutationListeners = new Set<SessionIdentityMutationListener>();
  const mocks = {
    callGateway:
      vi.fn<
        (request: {
          method?: string;
          params?: Record<string, unknown>;
          scopes?: string[];
          timeoutMs?: number | null;
        }) => Promise<Record<string, unknown>>
      >(),
    onAgentEvent: vi.fn<(_handler: (event: AgentEventPayload) => void) => typeof noop>(() => noop),
    getAgentRunContext: vi.fn<(_runId: string) => unknown>(() => undefined),
    getRuntimeConfig: vi.fn<() => OpenClawConfig>(() => ({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const },
    })),
    entries: {} as Record<string, SessionEntry>,
    loadSessionEntry: vi.fn<typeof loadSessionEntry>(
      (scope): ReturnType<typeof loadSessionEntry> => mocks.entries[scope.sessionKey],
    ),
    listSessionEntriesCore: vi.fn<typeof listSessionEntriesCore>(
      (): ReturnType<typeof listSessionEntriesCore> =>
        Object.entries(mocks.entries).map(([sessionKey, entry]) => ({ sessionKey, entry })),
    ),
    patchSessionEntryCore: vi.fn<typeof patchSessionEntryCore>(
      async (scope, update, options = {}): ReturnType<typeof patchSessionEntryCore> => {
        const current = mocks.entries[scope.sessionKey];
        if (!current) {
          return null;
        }
        const patch = await update({ ...current }, { existingEntry: { ...current } });
        if (options.shouldCommit?.() === false) {
          return null;
        }
        options.assertCommitAllowed?.();
        if (!patch) {
          return current;
        }
        const next = options.replaceEntry ? (patch as SessionEntry) : { ...current, ...patch };
        mocks.entries[scope.sessionKey] = next;
        return next;
      },
    ),
    resolveAgentIdFromSessionKey: vi.fn((sessionKey: string) => {
      return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
    }),
    resolveStorePath: vi.fn(() => "/tmp/test-session-store.json"),
    emitSessionLifecycleEvent: vi.fn(),
    onSessionIdentityMutation: vi.fn((listener: SessionIdentityMutationListener) =>
      registerListener(sessionIdentityMutationListeners, listener),
    ),
    emitSessionIdentityMutation: vi.fn((mutation: SessionIdentityMutation) =>
      notifyListeners(sessionIdentityMutationListeners, mutation),
    ),
    clearSubagentRunsReadCacheForTest: vi.fn(),
    persistSubagentRunsToDisk: vi.fn<typeof persistSubagentRunsToDisk>(),
    persistSubagentRunsToDiskOrThrow: vi.fn<typeof persistSubagentRunsToDiskOrThrow>(),
    restoreSubagentRunsFromDisk: vi.fn<typeof restoreSubagentRunsFromDisk>(() => 0),
    getSubagentRunsSnapshotForRead: vi.fn(
      (runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>) =>
        new Map(runs),
    ),
    getSubagentRunsSnapshotForChildSession: vi.fn(
      (runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>) =>
        new Map(runs),
    ),
    getSubagentRunsSnapshotForController: vi.fn(
      (runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>) =>
        new Map(runs),
    ),
    captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
    cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
    runSubagentAnnounceFlow: vi.fn(async (): Promise<"delivered" | "retryable"> => "delivered"),
    maybeWakeRequesterAfterAllChildrenSettled: vi.fn(
      async (wakeParams: {
        settledEntry: SubagentRunRecord;
        completeBatch(batch: readonly SubagentRunRecord[]): void;
      }) => {
        wakeParams.completeBatch([wakeParams.settledEntry]);
        return false;
      },
    ),
    getGlobalHookRunner: vi.fn(() => null),
    ensureContextEnginesInitialized: vi.fn(),
    loadAgentRuntimePluginRegistryHandle: vi.fn(),
    resolveContextEngine: vi.fn(),
    onSubagentEnded: vi.fn<
      (params: { childSessionKey?: string }, context?: unknown) => Promise<void>
    >(async () => {}),
    runSubagentEnded: vi.fn(async () => {}),
    removeInternalSessionEffectsSession: vi.fn(async () => {}),
    resolveAgentTimeoutMs: vi.fn(() => 1_000),
    dispatchRecoveryAgent: vi.fn(),
    getGatewayRecoveryRuntime: vi.fn(() => ({
      dispatchAgent: mocks.dispatchRecoveryAgent as GatewayRecoveryRuntime["dispatchAgent"],
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(),
    })),
    lifecycleGeneration: "test-generation",
  };
  return mocks;
}
