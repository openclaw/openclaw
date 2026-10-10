/** SQLite-backed Codex app-server thread bindings. */

import {
  AgentHarnessSessionSupersededError,
  embeddedAgentLog,
  type AgentHarnessSessionDeletionMutation,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createNativeSessionBindingLifecycle,
  reclaimNativeSessionGenerationWithAuthority,
  resolveNativeSessionBindingWithAuthority,
  type NativeSessionBindingAuthority,
  type NativeSessionBindingLeaseOptions,
  type NativeSessionBindingStateStore,
  type NativeSessionGenerationAdoptionResult,
  type NativeSessionGenerationOperationsV2,
  type NativeSessionGenerationReclaimPlan,
} from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type { CodexManagedThreadStore } from "./managed-thread-store.js";
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import type { CodexNativeSubagentPendingAssignment } from "./native-subagent-pending-assignments.js";
import {
  adoptCodexNativeSubagentSubmissions,
  type CodexNativeSubagentSubmission,
} from "./native-subagent-submission.js";
import {
  CODEX_APP_SERVER_BINDING_LEASE,
  PHYSICAL_SESSION_RETIRE_TTL_MS,
} from "./session-binding-meta.js";
import {
  mutateNativeSubagentBinding,
  type CodexNativeSubagentBindingMutation,
} from "./session-binding-native-mutations.js";
import {
  readCurrentNativePendingAssignments,
  preserveNativePendingAssignments,
  preserveNativeTaskImport,
  bindingStoreKey,
  matchesPendingSupervisionBranch,
  ownsStoredSessionGeneration,
  preserveCodexNativeSubagentSubmissions,
  readCurrentCodexAppServerBinding,
  readCurrentCodexAppServerBindings,
  readCurrentCodexNativeSubagentSubmissions,
  readStoredCodexAppServerBinding,
  validateBindingForWrite,
  type CodexAppServerBindingIdentity,
  type CodexAppServerPendingSupervisionBranch,
  type CodexAppServerThreadBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding-record.js";
export {
  assertCodexBindingMayBeReplaced,
  bindingStoreKey,
  CodexSupervisionBindingReplacementError,
  readCodexAppServerThreadBinding,
  readStoredCodexAppServerBinding,
  sessionBindingIdentity,
  validateBindingForWrite,
  type CodexAppServerBindingIdentity,
  type CodexAppServerContextEngineBinding,
  type CodexAppServerContextEngineProjectionBinding,
  type CodexAppServerPendingSupervisionBranch,
  type CodexAppServerThreadBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding-record.js";

export { combineNativeSessionBindingAuthority as combineCodexBindingAuthority } from "openclaw/plugin-sdk/agent-harness-session-runtime";
export {
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint,
  normalizeStoredCodexAppServerBindingFingerprints,
} from "./session-binding-codec.js";
export type CodexBindingAuthority = NativeSessionBindingAuthority;
export type CodexBindingWithCurrent = NativeSessionBindingAuthority["withCurrent"];

export {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
} from "./session-binding-meta.js";

type CodexAppServerBindingMutation =
  | CodexNativeSubagentBindingMutation
  | {
      kind: "set";
      binding: CodexAppServerThreadBinding;
      if?: { kind: "absent" };
    }
  | {
      kind: "patch";
      threadId: string;
      clientId?: string;
      patch: Partial<Omit<CodexAppServerThreadBinding, "threadId">>;
    }
  | {
      kind: "replace-thread";
      expectedThreadId: string;
      binding: CodexAppServerThreadBinding;
    }
  | {
      kind: "patch-pending-supervision-branch";
      expected: CodexAppServerPendingSupervisionBranch;
      pending: CodexAppServerPendingSupervisionBranch;
    }
  | {
      kind: "commit-pending-supervision-branch";
      expected: CodexAppServerPendingSupervisionBranch;
      threadId: string;
      patch: Partial<Omit<CodexAppServerThreadBinding, "threadId" | "pendingSupervisionBranch">>;
    }
  | {
      kind: "reclaim-generation";
      expectedPreviousSessionId: string;
    }
  | {
      kind: "clear";
      threadId?: string;
      clientId?: string;
    };

export type CodexSessionGenerationRetirementResult = "applied" | "absent" | "conflict";

/** Attempt cleanup may only clear the physical owner captured before its awaited work. */
export async function clearCodexBindingForClient(
  store: CodexAppServerBindingStore,
  identity: CodexAppServerBindingIdentity,
  thread: Pick<CodexAppServerThreadBinding, "threadId" | "clientId">,
  authority: CodexBindingAuthority,
): Promise<boolean> {
  if (!thread.clientId) {
    return false;
  }
  return await store.mutate(
    identity,
    { kind: "clear", threadId: thread.threadId, clientId: thread.clientId },
    authority.assertCurrent,
    authority,
  );
}

export type CodexBindingStateStore = NativeSessionBindingStateStore<StoredCodexAppServerBinding> &
  Pick<PluginStateSyncKeyedStore<StoredCodexAppServerBinding>, "entries"> & {
    asyncReads: Pick<PluginStateKeyedStore<StoredCodexAppServerBinding>, "lookup" | "lookupMany">;
  };

function bindingLeaseLostError(key: string, cause?: unknown): Error {
  return new Error(`Lost Codex binding lease: ${key}`, cause === undefined ? undefined : { cause });
}

export type CodexAppServerBindingStore = {
  /** Durable ownership rows kept separate from replaceable session bindings. */
  managedThreads?: CodexManagedThreadStore;
  read(identity: CodexAppServerBindingIdentity): CodexAppServerThreadBinding | undefined;
  /** Fresh worker-backed acquisition with row-ordered binding validation. */
  readMany: (
    identities: readonly CodexAppServerBindingIdentity[],
  ) => AsyncGenerator<CodexAppServerThreadBinding | undefined, undefined, void>;
  readNativeSubagentAssignments?(
    identity: CodexAppServerBindingIdentity,
    owner: CodexNativeSubagentHistoryOwner,
  ): readonly CodexNativeSubagentPendingAssignment[];
  readNativeSubagentSubmissions(
    identity: CodexAppServerBindingIdentity,
    owner: CodexNativeSubagentHistoryOwner,
  ): readonly CodexNativeSubagentSubmission[];
  hasOtherThreadOwner(
    threadId: string,
    currentIdentity?: CodexAppServerBindingIdentity,
  ): Promise<boolean>;
  mutate(
    identity: CodexAppServerBindingIdentity,
    mutation: CodexAppServerBindingMutation,
    assertCurrent?: () => void,
    authority?: CodexBindingAuthority,
  ): Promise<boolean>;
  prepareSessionGenerationReclaim(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
  ): Promise<NativeSessionGenerationReclaimPlan>;
  adoptSessionGeneration(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
    expectedPreviousSessionId: string,
    assertCurrent?: () => void,
    authority?: CodexBindingAuthority,
  ): Promise<NativeSessionGenerationAdoptionResult>;
  resetSessionGeneration(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
  ): Promise<CodexSessionGenerationRetirementResult>;
  retireSessionGeneration(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
  ): Promise<CodexSessionGenerationRetirementResult>;
  withSessionDeletion<T>(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
    assertCurrent: () => void,
    run: (
      binding: CodexAppServerThreadBinding | undefined,
      mutation: AgentHarnessSessionDeletionMutation,
    ) => Promise<T>,
  ): Promise<T>;
  withThreadArchiveFence<T>(run: () => Promise<T>): Promise<T>;
  withLease<T>(
    identity: CodexAppServerBindingIdentity,
    run: () => Promise<T>,
    options?: { assertCurrent?: () => void; authority?: CodexBindingAuthority },
  ): Promise<T>;
};

type CodexSessionGenerationReclaimParams = {
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  config?: OpenClawConfig;
  storePath?: string;
  assertCurrent?: () => void;
  bindingStore: CodexAppServerBindingStore;
  reclaimStale?: boolean;
};

/** Builds the terminal coordination error used when a newer OpenClaw session owns the binding. */
export function createCodexSessionGenerationSupersededError(
  sessionId: string,
): AgentHarnessSessionSupersededError {
  return new AgentHarnessSessionSupersededError(
    `Codex session generation is no longer current: ${sessionId}`,
  );
}

/** Lets the authoritative OpenClaw session generation claim a stale stable binding row. */
export async function reclaimCurrentCodexSessionGeneration(
  params: CodexSessionGenerationReclaimParams,
): Promise<boolean> {
  return await reclaimNativeSessionGenerationWithAuthority({
    ...params,
    target: params.identity,
    generation: codexSessionGenerationOperations(params.bindingStore, params.identity),
    createSupersededError: createCodexSessionGenerationSupersededError,
  });
}

/** Resolve continuity before selecting native queues, catalogs, or connections. */
export async function resolveCodexSessionBinding(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  config?: OpenClawConfig;
  storePath?: string;
  reclaimStale?: boolean;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  assertBinding?: (binding: CodexAppServerThreadBinding | undefined) => void;
  authority?: CodexBindingAuthority;
}): Promise<{
  binding: CodexAppServerThreadBinding | undefined;
  authority: CodexBindingAuthority;
}> {
  const identity = params.identity;
  return await resolveNativeSessionBindingWithAuthority({
    ...params,
    ...(identity.kind === "session"
      ? {
          target: identity,
          generation: codexSessionGenerationOperations(params.bindingStore, identity),
        }
      : {}),
    readBinding: (sessionId) =>
      params.bindingStore.read(
        sessionId && identity.kind === "session" ? { ...identity, sessionId } : identity,
      ),
    createSupersededError: createCodexSessionGenerationSupersededError,
  });
}

/** Creates the single binding facade owned by the Codex plugin runtime. */
export function createCodexAppServerBindingStore(
  state: CodexBindingStateStore,
): CodexAppServerBindingStore {
  const lifecycle = createNativeSessionBindingLifecycle<StoredCodexAppServerBinding>(state, {
    workerCodec: "codex",
    readRecord: readStoredCodexAppServerBinding,
    lease: CODEX_APP_SERVER_BINDING_LEASE,
    releaseTtlMs: (key, current) =>
      current.nativeSubagentTaskImport !== undefined ||
      current.state === "active" ||
      (current.retired === true && !key.startsWith("session:"))
        ? undefined
        : current.retired === true
          ? PHYSICAL_SESSION_RETIRE_TTL_MS
          : 1,
    onReleaseFailure: (key, error) =>
      embeddedAgentLog.warn("failed to release codex app-server binding lease", { key, error }),
    errors: {
      atomicUpdatesRequired: "Codex app-server bindings require atomic plugin-state updates",
      invalidRow: (key) => new Error(`Invalid Codex app-server binding row: ${key}`),
      lostLease: bindingLeaseLostError,
      leaseTimeout: (key) => new Error(`Timed out waiting for Codex binding lease: ${key}`),
      acquisitionRejected: (key) => new Error(`Codex binding generation was retired: ${key}`),
      mutationBlocked:
        "Codex binding mutation blocked while a native archive is in progress; retry",
      conditionalDeletionRequired:
        "Codex session deletion requires conditional plugin-state deletion",
      deletionChanged: "Codex binding changed before session deletion",
      rollbackChanged: "Codex binding changed before session deletion rollback",
    },
  });

  const prepareLease = (
    identity: CodexAppServerBindingIdentity,
    options: {
      allowRetired?: boolean;
      assertCurrent?: () => void;
      authority?: CodexBindingAuthority;
    } = {},
  ): NativeSessionBindingLeaseOptions<StoredCodexAppServerBinding> => ({
    assertCurrent: options.assertCurrent,
    authority: options.authority,
    prepareLease(current, lease) {
      if (
        current?.state === "cleared" &&
        current.retired === true &&
        ownsStoredSessionGeneration(identity, current) &&
        !options.allowRetired
      ) {
        return undefined;
      }
      if (current?.state === "active") {
        return { ...current, ...preservedSessionGeneration(identity, current), lease };
      }
      if (current?.state === "cleared" && current.retired === true) {
        return { ...current, lease };
      }
      return {
        version: 1,
        state: "cleared",
        ...preservedSessionGeneration(identity, current),
        ...preserveNativeTaskImport(current),
        lease,
      };
    },
  });

  const transitionSessionGeneration = async (
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
    mode: "reset" | "retire",
  ): Promise<CodexSessionGenerationRetirementResult> => {
    return await lifecycle.withMutation(async () => {
      const key = bindingStoreKey(identity);
      const ttlMs =
        mode === "reset"
          ? lifecycle.hasLease(key)
            ? undefined
            : 1
          : identity.sessionKey?.trim()
            ? undefined
            : PHYSICAL_SESSION_RETIRE_TTL_MS;
      return await lifecycle.transact(
        key,
        (current, leaseToken) => {
          if (!current) {
            return { result: "absent" as const };
          }
          if (!ownsStoredSessionGeneration(identity, current)) {
            return { result: "conflict" as const };
          }
          // Retirement is idempotent, but reset cannot clear a same-id deletion fence.
          // Only the authoritative session-store reclaim path can prove an in-place reset.
          if (current.state === "cleared" && current.retired === true) {
            return { result: mode === "retire" ? ("applied" as const) : ("conflict" as const) };
          }
          return {
            result: "applied" as const,
            next: {
              version: 1,
              state: "cleared",
              ...(mode === "retire" ? { retired: true as const } : {}),
              ...storedSessionGeneration(identity, current),
              ...preserveNativeTaskImport(current),
              ...(current.lease && current.lease.token === leaseToken
                ? { lease: current.lease }
                : {}),
            },
          };
        },
        (next) => (next.nativeSubagentTaskImport !== undefined ? undefined : ttlMs),
      );
    });
  };

  return {
    read: (identity) => readCurrentCodexAppServerBinding(state, identity),
    readMany: (identities) => readCurrentCodexAppServerBindings(state.asyncReads, identities),
    readNativeSubagentAssignments: (identity, owner) =>
      readCurrentNativePendingAssignments(state, identity, owner),
    readNativeSubagentSubmissions: (identity, owner) =>
      readCurrentCodexNativeSubagentSubmissions(state, identity, owner),

    async hasOtherThreadOwner(threadId, currentIdentity) {
      const currentKey = currentIdentity ? bindingStoreKey(currentIdentity) : undefined;
      return state.entries().some(({ key, value }) => {
        const stored = readStoredCodexAppServerBinding(value);
        if (!stored) {
          throw new Error(`Invalid Codex app-server binding row: ${key}`);
        }
        const isCurrentOwner =
          currentIdentity !== undefined &&
          key === currentKey &&
          (currentIdentity.kind === "conversation" ||
            stored.sessionId === currentIdentity.sessionId.trim());
        return stored.state === "active" && stored.binding.threadId === threadId && !isCurrentOwner;
      });
    },

    async prepareSessionGenerationReclaim(identity) {
      const key = bindingStoreKey(identity);
      const raw = state.lookup(key);
      const current = readStoredCodexAppServerBinding(raw);
      if (raw !== undefined && !current) {
        throw new Error(`Invalid Codex app-server binding row: ${key}`);
      }
      if (!current) {
        return { kind: "resolved", result: true };
      }
      const currentSessionId = current.sessionId;
      if (!currentSessionId) {
        return {
          kind: "resolved",
          result: current.state !== "cleared" || current.retired !== true,
        };
      }
      if (currentSessionId === identity.sessionId) {
        return current.state === "cleared" && current.retired === true
          ? { kind: "verify", expectedPreviousSessionId: currentSessionId }
          : { kind: "resolved", result: true };
      }
      return { kind: "verify", expectedPreviousSessionId: currentSessionId };
    },

    async mutate(identity, mutation, assertCurrent, authority) {
      return await lifecycle.withMutation(async () => {
        const key = bindingStoreKey(identity);
        // A retained legacy sidecar may be revisited by doctor after runtime
        // clear. Keep provenance so migration cannot resurrect its stale thread.
        const retainLegacyClear =
          mutation.kind === "clear" && key.startsWith("conversation:legacy-");
        return await lifecycle.transact(
          key,
          (current, leaseToken) => {
            if (
              mutation.kind === "record-native-subagent-assignment" ||
              mutation.kind === "consume-native-subagent-assignment" ||
              mutation.kind === "record-native-subagent-submission" ||
              mutation.kind === "consume-native-subagent-submission"
            ) {
              return mutateNativeSubagentBinding({ identity, current, mutation, assertCurrent });
            }
            const ownsGeneration = ownsStoredSessionGeneration(identity, current);
            const ownedLease =
              current?.lease && current.lease.token === leaseToken ? { lease: current.lease } : {};
            if (mutation.kind === "reclaim-generation") {
              if (identity.kind !== "session" || !identity.sessionKey?.trim()) {
                return { result: false };
              }
              if (!current) {
                return { result: true };
              }
              if (ownsGeneration) {
                if (
                  current.state !== "cleared" ||
                  current.retired !== true ||
                  current.sessionId !== mutation.expectedPreviousSessionId
                ) {
                  return {
                    result: current.state !== "cleared" || current.retired !== true,
                  };
                }
                // The authoritative session-store check proves this same-id fence
                // belongs to the previous in-place lifecycle, not live work.
              } else if (
                current.sessionId !== mutation.expectedPreviousSessionId ||
                // Only explicit supervision adoption can transfer private user-home ownership.
                (current.state === "active" && current.binding.connectionScope === "supervision")
              ) {
                return { result: false };
              }
              return {
                result: true,
                next: {
                  version: 1,
                  state: "cleared",
                  sessionId: identity.sessionId,
                  ...preserveNativeTaskImport(current),
                  ...ownedLease,
                },
              };
            }
            const storedActive = current?.state === "active" ? current : undefined;
            const active = ownsGeneration ? storedActive : undefined;
            const retiredGeneration =
              current?.state === "cleared" && current.retired === true && ownsGeneration;
            const preservesSupervisionOwner =
              mutation.kind === "set" &&
              active?.binding.connectionScope === "supervision" &&
              isSameSupervisionOwner(active.binding, mutation.binding);
            const replacesExpectedOrdinaryOwner =
              mutation.kind === "replace-thread" &&
              active?.binding.threadId === mutation.expectedThreadId &&
              active.binding.connectionScope !== "supervision" &&
              mutation.binding.connectionScope !== "supervision" &&
              mutation.binding.threadId !== mutation.expectedThreadId;
            if (
              // Recheck the physical owner on every CAS retry. Explicit undefined
              // pins an absent legacy client ID; lifecycle operations omit the field.
              ((mutation.kind === "patch" || mutation.kind === "clear") &&
                Object.hasOwn(mutation, "clientId") &&
                mutation.clientId !== active?.binding.clientId) ||
              (mutation.kind === "set" &&
                ((mutation.if?.kind === "absent" && storedActive) ||
                  (current !== undefined && !ownsGeneration) ||
                  retiredGeneration ||
                  (active?.binding.connectionScope === "supervision" &&
                    !preservesSupervisionOwner))) ||
              (mutation.kind === "patch" && active?.binding.threadId !== mutation.threadId) ||
              (mutation.kind === "replace-thread" && !replacesExpectedOrdinaryOwner) ||
              ((mutation.kind === "patch-pending-supervision-branch" ||
                mutation.kind === "commit-pending-supervision-branch") &&
                !matchesPendingSupervisionBranch(active?.binding, mutation.expected)) ||
              (mutation.kind === "clear" &&
                (!ownsGeneration ||
                  (mutation.threadId !== undefined &&
                    active?.binding.threadId !== mutation.threadId) ||
                  active?.binding.connectionScope === "supervision"))
            ) {
              return { result: false };
            }
            if (mutation.kind === "clear" && retiredGeneration) {
              return { result: true };
            }
            if (mutation.kind === "clear") {
              return {
                result: true,
                next: {
                  version: 1,
                  state: "cleared",
                  ...storedSessionGeneration(identity, current),
                  ...preserveNativeTaskImport(current),
                  ...ownedLease,
                },
              };
            }
            let binding: CodexAppServerThreadBinding;
            if (mutation.kind === "set" || mutation.kind === "replace-thread") {
              binding = mutation.binding;
            } else if (mutation.kind === "patch-pending-supervision-branch") {
              binding = {
                ...active!.binding,
                pendingSupervisionBranch: mutation.pending,
              };
            } else {
              binding = {
                ...active!.binding,
                ...mutation.patch,
                threadId: mutation.threadId,
                ...(mutation.kind === "commit-pending-supervision-branch"
                  ? { pendingSupervisionBranch: undefined }
                  : {}),
              };
            }
            binding = validateBindingForWrite(binding);
            const nativeSubagentSubmissions = active
              ? preserveCodexNativeSubagentSubmissions(
                  active.binding,
                  binding,
                  active.nativeSubagentSubmissions,
                )
              : undefined;
            const nativeSubagentAssignments = active
              ? preserveNativePendingAssignments(
                  active.binding,
                  binding,
                  active.nativeSubagentAssignments,
                )
              : undefined;
            return {
              result: true,
              next: {
                version: 1,
                state: "active",
                binding,
                ...(nativeSubagentAssignments !== undefined ? { nativeSubagentAssignments } : {}),
                ...(nativeSubagentSubmissions !== undefined ? { nativeSubagentSubmissions } : {}),
                ...storedSessionGeneration(identity, current),
                ...preserveNativeTaskImport(current),
                ...ownedLease,
              },
            };
          },
          // Plain clears may expire immediately: a stale generation that re-sets
          // the key afterwards is fenced by ownsStoredSessionGeneration on read
          // and displaced via reclaim-generation; durable stable-key fences come
          // from retireSessionGeneration, not runtime clears.
          (next) =>
            mutation.kind === "clear" &&
            next.nativeSubagentTaskImport === undefined &&
            !retainLegacyClear &&
            !lifecycle.hasLease(key)
              ? 1
              : undefined,
          assertCurrent,
          authority,
        );
      });
    },

    async adoptSessionGeneration(identity, expectedPreviousSessionId, assertCurrent, authority) {
      return await lifecycle.withMutation(async () => {
        const key = bindingStoreKey(identity);
        const expectedSessionId = expectedPreviousSessionId.trim();
        const targetSessionId = identity.sessionId.trim();
        if (!expectedSessionId) {
          throw new Error("Codex session generation adoption requires the previous session id");
        }
        // The host may commit first and restart before this fence moves. Only its
        // recorded predecessor can transfer; a delayed admission cannot move it back.
        return await lifecycle.transact(
          key,
          (current) => {
            if (current?.state !== "active") {
              return { result: "absent" as const };
            }
            if (current.sessionId === targetSessionId) {
              return { result: "current" as const };
            }
            if (current.sessionId !== expectedSessionId) {
              return { result: "conflict" as const };
            }
            const {
              nativeSubagentSubmissions,
              nativeSubagentAssignments: _assignments,
              ...bindingOwner
            } = current;
            const adoptedSubmissions =
              adoptCodexNativeSubagentSubmissions(nativeSubagentSubmissions);
            return {
              result: "adopted" as const,
              next: {
                ...bindingOwner,
                sessionId: targetSessionId,
                ...(adoptedSubmissions !== undefined
                  ? { nativeSubagentSubmissions: adoptedSubmissions }
                  : {}),
              },
            };
          },
          undefined,
          assertCurrent,
          authority,
        );
      });
    },

    resetSessionGeneration: (identity) => transitionSessionGeneration(identity, "reset"),
    retireSessionGeneration: (identity) => transitionSessionGeneration(identity, "retire"),

    withThreadArchiveFence: lifecycle.withExclusiveMutationFence,

    async withSessionDeletion(identity, assertCurrent, run) {
      return await lifecycle.withDeletion(
        bindingStoreKey(identity),
        {
          ...prepareLease(identity, { allowRetired: true, assertCurrent }),
          assertCurrent,
          assertRecordCurrent(stored) {
            if (!stored || !ownsStoredSessionGeneration(identity, stored)) {
              throw new Error("Codex binding generation changed before session deletion");
            }
          },
        },
        (stored, mutation) =>
          run(stored?.state === "active" ? stored.binding : undefined, mutation),
      );
    },

    withLease: (identity, run, options) =>
      lifecycle.withLease(bindingStoreKey(identity), run, prepareLease(identity, options)),
  };
}

function codexSessionGenerationOperations(
  store: CodexAppServerBindingStore,
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
): NativeSessionGenerationOperationsV2 {
  return {
    prepareReclaim: () => store.prepareSessionGenerationReclaim(identity),
    adopt: (expectedPreviousSessionId, authority) =>
      store.adoptSessionGeneration(
        identity,
        expectedPreviousSessionId,
        authority.assertCurrent,
        authority,
      ),
    reclaim: (expectedPreviousSessionId, authority) =>
      store.mutate(
        identity,
        { kind: "reclaim-generation", expectedPreviousSessionId },
        authority.assertCurrent,
        authority,
      ),
  };
}

function isSameSupervisionOwner(
  current: CodexAppServerThreadBinding,
  replacement: CodexAppServerThreadBinding,
): boolean {
  return (
    replacement.connectionScope === "supervision" &&
    replacement.threadId === current.threadId &&
    replacement.supervisionSourceThreadId === current.supervisionSourceThreadId
  );
}

function storedSessionGeneration(
  identity: CodexAppServerBindingIdentity,
  current: StoredCodexAppServerBinding | undefined,
): { sessionId?: string } {
  if (identity.kind === "session") {
    return { sessionId: identity.sessionId };
  }
  return current?.sessionId ? { sessionId: current.sessionId } : {};
}

function preservedSessionGeneration(
  identity: CodexAppServerBindingIdentity,
  current: StoredCodexAppServerBinding | undefined,
): { sessionId?: string } {
  if (current?.sessionId) {
    return { sessionId: current.sessionId };
  }
  return storedSessionGeneration(identity, current);
}
