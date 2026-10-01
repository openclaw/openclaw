import type { Result } from "@openclaw/normalization-core/result";
import { vi } from "vitest";
import type {
  listSessionEntriesCore,
  loadSessionEntry,
  patchSessionEntryCore,
  SessionEntryReadScope,
} from "../../../config/sessions/session-accessor.js";
import type { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { prepareSessionGenerationFacts } from "../../../config/sessions/session-delivery-generation.js";
import type { captureSessionEntryCurrentRead } from "../../../config/sessions/session-entry-current-runtime.js";
import type { SessionEntryCurrentFacts } from "../../../config/sessions/session-entry-current.types.js";
import type { SessionEntryReadWorkerOwner } from "../../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import type {
  SessionIdentityMutation,
  SessionIdentityMutationListener,
} from "../../../sessions/session-lifecycle-events.js";
import { notifyListeners, registerListener } from "../../../shared/listeners.js";
import type { SubagentAnnounceFlowOutcome } from "../announce/subagent-announce.js";
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
    readSessionCurrent: vi.fn<
      (scope: Pick<SessionEntryReadScope, "sessionKey">) => SessionEntryCurrentFacts | undefined
    >((scope): SessionEntryCurrentFacts | undefined => {
      const entry = mocks.entries[scope.sessionKey];
      return (
        entry && {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          lifecycleRunId: entry.lifecycleRunId,
          activeWriterRunId: entry.activeWriterRunId,
          subagentRecovery: entry.subagentRecovery,
        }
      );
    }),
    applySessionEntryExactReplacements: vi.fn<typeof applySessionEntryExactReplacements>(
      async <T>(
        params: Parameters<typeof applySessionEntryExactReplacements<T>>[0],
      ): Promise<T> => {
        const entries = (params.sessionKeys ?? Object.keys(mocks.entries)).flatMap((sessionKey) => {
          const entry = mocks.entries[sessionKey];
          return entry ? [{ sessionKey, entry: structuredClone(entry) }] : [];
        });
        const selectedKeys = new Set(entries.map(({ sessionKey }) => sessionKey));
        const operation = await params.update(entries);
        const replacements = [...(operation.replacements ?? [])].filter(({ sessionKey }) =>
          selectedKeys.has(sessionKey),
        );
        if (replacements.length) {
          params.assertCommitAllowed?.();
          for (const { sessionKey, entry } of replacements) {
            mocks.entries[sessionKey] = entry;
          }
        }
        return operation.result;
      },
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
    restoreSubagentRunsFromDisk: vi.fn<typeof restoreSubagentRunsFromDisk>(async () => 0),
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
    runSubagentAnnounceFlow: vi.fn(async (): Promise<SubagentAnnounceFlowOutcome> => "delivered"),
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
  return Object.assign(mocks, {
    mockRestoredRuns: (createEntries: () => SubagentRunRecord[]) =>
      mocks.restoreSubagentRunsFromDisk.mockImplementation(async ({ runs }) => {
        const entries = createEntries();
        for (const entry of entries) {
          runs.set(entry.runId, entry);
        }
        return entries.length;
      }),
    sessionAccessors: {
      findTranscriptEvent: vi.fn(async () => undefined),
      listSessionEntriesCore: mocks.listSessionEntriesCore,
      listSessionEntriesReadOnly: mocks.listSessionEntriesCore,
      loadSessionEntry: mocks.loadSessionEntry,
      loadSessionEntryReadOnly: mocks.loadSessionEntry,
      patchSessionEntryCore: mocks.patchSessionEntryCore,
    },
    prepareSessionGenerationFacts: (
      input: Parameters<typeof prepareSessionGenerationFacts>[0],
    ): ReturnType<typeof prepareSessionGenerationFacts> => {
      let active = true;
      const assertCurrent = () => {
        const entry = mocks.readSessionCurrent(input);
        if (
          !active ||
          (entry?.sessionId ?? null) !== input.sessionId ||
          (entry?.lifecycleRevision ?? null) !== input.lifecycleRevision
        ) {
          throw new Error("Registry fixture lost its original session generation.");
        }
      };
      assertCurrent();
      return Promise.resolve({
        assertCurrent,
        release: () => {
          active = false;
        },
      });
    },
    captureSessionEntryCurrentRead: (
      scope: Parameters<typeof captureSessionEntryCurrentRead>[0],
      owner: Parameters<typeof captureSessionEntryCurrentRead>[1],
    ): ReturnType<typeof captureSessionEntryCurrentRead> => {
      owner.assertCurrent();
      return {
        kind: "native",
        assertSourceCurrent: noop,
        readCurrent: () => mocks.readSessionCurrent(scope),
      };
    },
    withSessionEntryReadOnlyInWorker: async <T>(
      scope: SessionEntryReadScope,
      assertCurrent: () => void,
      consume: (
        read: Result<SessionEntry | undefined, unknown>,
        owner: SessionEntryReadWorkerOwner,
      ) => Promise<T>,
    ): Promise<T> => {
      assertCurrent();
      let read: Result<SessionEntry | undefined, unknown>;
      try {
        read = { ok: true, value: mocks.loadSessionEntry(scope) };
      } catch (error) {
        read = { ok: false, error };
      }
      const result = await consume(read, { kind: "native", assertCurrent });
      assertCurrent();
      return result;
    },
  });
}
