import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  listSessionCatalogEntries,
  sessionCatalogAdoptedSessionKey,
  sessionCatalogAdoptedSourceKey,
  type SessionCatalogEntrySnapshot,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexThread } from "./app-server/protocol.js";
import {
  reclaimCurrentCodexSessionGeneration,
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerPendingSupervisionBranch,
} from "./app-server/session-binding.js";
import {
  adoptionSessionKeyRest,
  catalogSessionActions,
  type AdoptedSessionEntry,
  type CodexSessionDisposition,
} from "./session-catalog-node-adoption.js";
import {
  boundedCatalogString,
  CatalogParamsError,
  CODEX_LOCAL_SESSION_HOST_ID,
  MAX_SESSION_ID_LENGTH,
  requireBoundThread,
} from "./session-catalog-parsing.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";
import {
  codexLastTerminalTurnId,
  codexUpstreamBaseline,
  type CodexUpstreamBaseline,
} from "./session-upstream-marker.js";

const CODEX_SUPERVISION_SESSION_KEY_PREFIX = "harness:codex:supervision:";
type ContinuedCodexSession = {
  sessionKey: string;
  disposition: CodexSessionDisposition;
  upstream?: CodexUpstreamBaseline & { connectionFingerprint: string };
};
const continueOperations = new Map<string, Promise<ContinuedCodexSession>>();

const boundCatalogSessionId = (value: unknown) =>
  boundedCatalogString(value, MAX_SESSION_ID_LENGTH);

export function requireIdleThread(thread: CodexThread, action: "continue" | "archive"): void {
  if (
    thread.status?.type === "idle" ||
    (action === "archive" && thread.status?.type === "notLoaded")
  ) {
    return;
  }
  if (thread.status?.type === "active") {
    throw new CatalogParamsError(
      `Codex session is active in this App Server; wait for it to finish before ${action === "continue" ? "starting a branch" : "archiving"}`,
    );
  }
  throw new CatalogParamsError(
    action === "archive"
      ? "Codex session cannot be archived in its current state"
      : "Codex session cannot start a branch in its current state",
  );
}

function adoptionSessionKey(threadId: string, sourceHomeId?: string): string {
  const source = sourceHomeId ? JSON.stringify([sourceHomeId, threadId]) : threadId;
  return sessionCatalogAdoptedSessionKey(CODEX_SUPERVISION_SESSION_KEY_PREFIX, source);
}

export function isAdoptionSessionKeyForThread(
  sessionKey: string,
  threadId: string,
  sourceHomeId?: string,
): boolean {
  return adoptionSessionKeyRest(sessionKey) === adoptionSessionKey(threadId, sourceHomeId);
}

type CodexSupervisionMarker = { sourceThreadId: string; sourceHomeId?: string };

type AdoptionCandidate = {
  agentId: string;
  sessionKey: string;
  sessionKeyRest: string;
  sessionId: string;
  marker: CodexSupervisionMarker;
  identity: ReturnType<typeof sessionBindingIdentity>;
};

// The snapshot revision retires derived facts; binding authority stays live below.
const adoptionCandidatesByRevision = new WeakMap<
  object,
  { config?: OpenClawConfig; agentId?: string; candidates: AdoptionCandidate[] }
>();

function readCodexSupervisionMarker(entry: {
  pluginExtensions?: Record<string, unknown>;
}): CodexSupervisionMarker | undefined {
  const codex = isRecord(entry.pluginExtensions?.codex) ? entry.pluginExtensions.codex : undefined;
  const marker = codex && isRecord(codex.supervision) ? codex.supervision : undefined;
  const sourceThreadId = marker?.sourceThreadId;
  const sourceHomeId = marker?.sourceHomeId;
  if (
    typeof sourceThreadId !== "string" ||
    !sourceThreadId.trim() ||
    (sourceHomeId !== undefined && (typeof sourceHomeId !== "string" || !sourceHomeId.trim()))
  ) {
    return undefined;
  }
  return {
    sourceThreadId: sourceThreadId.trim(),
    ...(typeof sourceHomeId === "string" ? { sourceHomeId: sourceHomeId.trim() } : {}),
  };
}

export async function listAdoptedSessionEntries(params: {
  agentId?: string;
  bindingStore: CodexAppServerBindingStore;
  config?: OpenClawConfig;
  runtime: PluginRuntime;
  sessionEntries?: SessionCatalogEntrySnapshot;
}): Promise<Map<string, AdoptedSessionEntry>> {
  function* candidates() {
    for (const { agentId, entry, sessionKey } of listSessionCatalogEntries({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      config: params.config ?? {},
      runtime: params.runtime,
      sessionEntries: params.sessionEntries,
    })) {
      const sessionKeyRest = adoptionSessionKeyRest(sessionKey);
      const marker = readCodexSupervisionMarker(entry);
      if (
        !sessionKeyRest.startsWith(CODEX_SUPERVISION_SESSION_KEY_PREFIX) ||
        !marker ||
        entry.initializationPending === true ||
        entry.agentHarnessId !== "codex" ||
        entry.modelSelectionLocked !== true
      ) {
        continue;
      }
      const sessionId = entry.sessionId?.trim();
      if (!sessionId) {
        continue;
      }
      yield {
        agentId,
        sessionKey,
        sessionKeyRest,
        sessionId,
        marker,
        identity: sessionBindingIdentity({ sessionId, sessionKey, config: params.config }),
      };
    }
  }
  const revision = params.sessionEntries?.revision;
  const cached = revision ? adoptionCandidatesByRevision.get(revision) : undefined;
  let prepared: AdoptionCandidate[];
  if (cached && cached.config === params.config && cached.agentId === params.agentId) {
    prepared = cached.candidates;
  } else {
    prepared = [...candidates()];
    if (revision) {
      adoptionCandidatesByRevision.set(revision, {
        config: params.config,
        agentId: params.agentId,
        candidates: prepared,
      });
    }
  }
  const bindings = params.bindingStore.readMany(prepared.map(({ identity }) => identity));
  try {
    const adopted = new Map<string, AdoptedSessionEntry>();
    for (const { agentId, sessionKey, sessionKeyRest, sessionId, marker } of prepared) {
      const binding = (await bindings.next()).value;
      const sourceThreadId = binding?.supervisionSourceThreadId?.trim();
      const boundThreadId = binding?.threadId.trim();
      if (
        binding?.connectionScope !== "supervision" ||
        !sourceThreadId ||
        !boundThreadId ||
        sessionKeyRest !== adoptionSessionKey(sourceThreadId, marker.sourceHomeId)
      ) {
        continue;
      }
      const sourceKey = sessionCatalogAdoptedSourceKey(
        marker.sourceHomeId ?? CODEX_LOCAL_SESSION_HOST_ID,
        sourceThreadId,
      );
      if (adopted.has(sourceKey)) {
        throw new Error(
          `multiple OpenClaw sessions adopt Codex thread ${sourceThreadId} from the same home`,
        );
      }
      adopted.set(sourceKey, { key: sessionKey, sessionId, agentId, boundThreadId });
    }
    return adopted;
  } finally {
    await bindings.return(undefined);
  }
}

type ContinueLocalCodexSessionParams = {
  agentId: string;
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  control: CodexSessionCatalogControl;
  threadId: string;
  hostId?: string;
  sourceHomeId?: string;
  allowLegacy?: boolean;
  onContinued?: (upstream: CodexUpstreamBaseline & { connectionFingerprint: string }) => void;
};

async function continueLocalCodexSessionInner(
  params: ContinueLocalCodexSessionParams,
): Promise<ContinuedCodexSession> {
  async function findAdoptedSessionEntry(runtime: PluginRuntime) {
    const adopted = await listAdoptedSessionEntries({ ...params, runtime });
    const exact = adopted.get(
      sessionCatalogAdoptedSourceKey(
        params.sourceHomeId ?? CODEX_LOCAL_SESSION_HOST_ID,
        params.threadId,
      ),
    );
    return (
      exact ??
      (params.sourceHomeId && params.allowLegacy === true
        ? adopted.get(sessionCatalogAdoptedSourceKey(CODEX_LOCAL_SESSION_HOST_ID, params.threadId))
        : undefined)
    );
  }
  await params.control.requireEligibleThread(params.threadId);
  const existing = await findAdoptedSessionEntry(params.api.runtime);
  if (existing) {
    const boundThreadId = requireBoundThread(existing);
    const boundThread = await params.control.readThread(boundThreadId, true);
    if (boundThread.id !== boundThreadId) {
      throw new Error("Codex app-server returned a different thread than requested");
    }
    // Catalog state can race archive/reset. Restore only the same locked generation
    // under the session-store write lock so a stale Open Chat cannot revive a replacement.
    const changedError = () =>
      new CatalogParamsError("Codex OpenClaw session changed before it could be opened. Retry.");
    const restored = await params.api.runtime.agent.session.prepareSessionEntryPatch({
      sessionKey: existing.key,
      readConsistency: "latest",
      preserveActivity: true,
      prepare: (entry) => {
        if (
          entry.sessionId?.trim() !== existing.sessionId ||
          entry.initializationPending === true ||
          entry.agentHarnessId !== "codex" ||
          entry.modelSelectionLocked !== true
        ) {
          throw changedError();
        }
        return { archivedAt: undefined, archivedBy: undefined, archiveReason: undefined };
      },
    });
    if (!restored) {
      throw changedError();
    }
    const connectionFingerprint = params.control.connectionFingerprint;
    return {
      sessionKey: existing.key,
      disposition: "existing",
      ...(connectionFingerprint
        ? {
            upstream: {
              connectionFingerprint,
              ...codexUpstreamBaseline(boundThread, boundCatalogSessionId),
            },
          }
        : {}),
    };
  }

  const sourceThread = await params.control.readThread(params.threadId, true);
  if (sourceThread.id !== params.threadId) {
    throw new Error("Codex app-server returned a different thread than requested");
  }
  if (sourceThread.status?.type !== "notLoaded") {
    requireIdleThread(sourceThread, "continue");
  }
  const connectionFingerprint = params.control.connectionFingerprint;
  if (!connectionFingerprint) {
    throw new Error("Codex Continue requires a pinned app-server connection");
  }
  async function createOrReuseAdoptedSession(): Promise<AdoptedSessionEntry> {
    const runtime = params.api.runtime;
    const adoptedEntry = await findAdoptedSessionEntry(runtime);
    if (adoptedEntry) {
      return adoptedEntry;
    }
    try {
      const spawnedCwd = sourceThread.cwd?.trim() || undefined;
      const pendingLastTurnId = codexLastTerminalTurnId(sourceThread, boundCatalogSessionId);
      const marker: CodexSupervisionMarker = {
        sourceThreadId: sourceThread.id,
        ...(params.sourceHomeId ? { sourceHomeId: params.sourceHomeId } : {}),
      };
      const { createImportedCodexSession } = await import("./app-server/session-history-import.js");
      const created = await createImportedCodexSession({
        runtime: params.api.runtime,
        bindingStore: params.bindingStore,
        config: params.config,
        key: adoptionSessionKey(sourceThread.id, params.sourceHomeId),
        agentId: params.agentId,
        displayName: sourceThread.name ?? undefined,
        thread: sourceThread,
        throughTurnId: pendingLastTurnId ?? null,
        recoverMatchingInitialEntry: true,
        initialEntry: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: {
              supervision: {
                ...marker,
                initializing: true,
                modelLocked: true,
              },
            },
          },
        },
        afterImport: async (entry, initialization) => {
          const identity = sessionBindingIdentity({
            sessionId: entry.sessionId,
            sessionKey: entry.key,
            config: params.config,
          });
          const sourceThreadId = sourceThread.id;
          const cwd = spawnedCwd ?? "";
          const lastTurnId = pendingLastTurnId || undefined;
          async function ensurePendingAdoptionBinding(): Promise<void> {
            const pending: CodexAppServerPendingSupervisionBranch = {
              sourceThreadId,
              connectionFingerprint,
              ...(lastTurnId ? { lastTurnId } : {}),
            };
            const ownsGeneration = await reclaimCurrentCodexSessionGeneration({
              assertCurrent: initialization.assertCurrent,
              bindingStore: params.bindingStore,
              identity,
              config: params.config,
            });
            initialization.assertCurrent();
            if (!ownsGeneration) {
              throw new Error(
                `failed to claim the OpenClaw session generation for ${sourceThreadId}`,
              );
            }
            const existingBinding = await params.bindingStore.readAsync(identity);
            initialization.assertCurrent();
            function matchesPendingAdoptionBinding(): boolean {
              const historyCoveredThrough = existingBinding?.historyCoveredThrough;
              return (
                existingBinding?.threadId === sourceThreadId &&
                existingBinding.connectionScope === "supervision" &&
                existingBinding.supervisionSourceThreadId === sourceThreadId &&
                existingBinding.cwd === cwd &&
                existingBinding.conversationSourceTransferComplete === true &&
                existingBinding.preserveNativeModel === true &&
                existingBinding.pendingSupervisionBranch?.sourceThreadId === sourceThreadId &&
                existingBinding.pendingSupervisionBranch.connectionFingerprint ===
                  connectionFingerprint &&
                existingBinding.pendingSupervisionBranch.lastTurnId === lastTurnId &&
                (existingBinding.pendingSupervisionBranch.cleanupThreadIds?.length ?? 0) === 0 &&
                typeof historyCoveredThrough === "string" &&
                Number.isFinite(Date.parse(historyCoveredThrough))
              );
            }
            if (existingBinding) {
              if (matchesPendingAdoptionBinding()) {
                return;
              }
              throw new Error(
                `OpenClaw session is already bound to Codex thread ${existingBinding.threadId}`,
              );
            }
            const binding = {
              threadId: sourceThreadId,
              connectionScope: "supervision" as const,
              supervisionSourceThreadId: sourceThreadId,
              cwd,
              historyCoveredThrough: new Date().toISOString(),
              conversationSourceTransferComplete: true as const,
              preserveNativeModel: true as const,
              pendingSupervisionBranch: pending,
            };
            await initialization.bind(binding);
          }
          await ensurePendingAdoptionBinding();
          return {
            pluginExtensions: {
              codex: {
                supervision: { ...marker, modelLocked: true },
              },
            },
          };
        },
      });
      return {
        key: created.key,
        sessionId: created.sessionId,
        agentId: created.agentId,
        boundThreadId: sourceThread.id,
      };
    } catch (error) {
      // Concurrent/retried Continue calls converge on the same trusted marker.
      // An unrelated entry at the deterministic key is never overwritten.
      const raced = await findAdoptedSessionEntry(runtime);
      if (raced) {
        return raced;
      }
      throw error;
    }
  }
  const adopted = await createOrReuseAdoptedSession();
  const boundThreadId = requireBoundThread(adopted);
  const baselineThread =
    boundThreadId === sourceThread.id
      ? sourceThread
      : await params.control.readThread(boundThreadId, true);
  if (baselineThread.id !== boundThreadId) {
    throw new Error("Codex app-server returned a different thread than requested");
  }
  return {
    sessionKey: adopted.key,
    disposition: "forked",
    upstream: {
      connectionFingerprint,
      ...codexUpstreamBaseline(baselineThread, boundCatalogSessionId),
    },
  };
}

/** Creates one locked OpenClaw branch whose first harness run forks the Codex source. */
export async function continueLocalCodexSession(params: ContinueLocalCodexSessionParams): Promise<{
  sessionKey: string;
  disposition: CodexSessionDisposition;
}> {
  const sourceKey = sessionCatalogAdoptedSourceKey(
    params.hostId ?? CODEX_LOCAL_SESSION_HOST_ID,
    params.threadId,
  );
  const operationKey = sessionCatalogAdoptedSourceKey(params.agentId, sourceKey);
  // Memoization is agent-qualified while the native action lock is source-qualified,
  // so different agents serialize on one thread without joining one adoption result.
  let operation = continueOperations.get(operationKey);
  if (!operation) {
    const run = async (control: CodexSessionCatalogControl) =>
      await continueLocalCodexSessionInner({ ...params, control });
    operation = catalogSessionActions.enqueue(sourceKey, async () =>
      params.control.withPinnedConnection(run),
    );
    continueOperations.set(operationKey, operation);
  }
  try {
    const { sessionKey, disposition, upstream } = await operation;
    // The native work is shared, but each request needs its own upstream seed.
    if (upstream) {
      params.onContinued?.(upstream);
    }
    return { sessionKey, disposition };
  } finally {
    if (continueOperations.get(operationKey) === operation) {
      continueOperations.delete(operationKey);
    }
  }
}
