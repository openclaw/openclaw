/** SQLite-backed Codex app-server thread bindings. */

import { createHash } from "node:crypto";
import {
  AgentHarnessSessionSupersededError,
  embeddedAgentLog,
  type AgentHarnessSessionDeletionMutation,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  captureNativeSessionGenerationAuthority,
  createNativeSessionBindingLifecycle,
  reclaimNativeSessionGeneration,
  resolveNativeSessionBinding,
  type NativeSessionBindingLeaseOptions,
  type NativeSessionBindingStateStore,
  type NativeSessionGenerationAdoptionResult,
  type NativeSessionGenerationOperations,
  type NativeSessionGenerationReclaimPlan,
} from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeCodexAppServerBindingModelProvider,
  type CodexAppServerAuthProfileLookup,
} from "./auth-profile.js";
import type { CodexManagedThreadStore } from "./managed-thread-store.js";
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import {
  adoptCodexNativeSubagentSubmissions,
  mutateCodexNativeSubagentSubmissions,
  type CodexNativeSubagentSubmission,
} from "./native-subagent-submission.js";
import {
  bindingStoreKey,
  matchesCodexNativeSubagentSubmissionBinding,
  ownsStoredSessionGeneration,
  preserveCodexNativeSubagentSubmissions,
  readCodexAppServerThreadBinding,
  readCodexBindingTimestamp,
  readCurrentCodexAppServerBinding,
  readCurrentCodexAppServerBindings,
  readCurrentCodexNativeSubagentSubmissions,
  readPluginAppPolicyContext,
  readStoredCodexAppServerBinding,
  stripUndefinedBinding,
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

const BINDING_LEASE_RETRY_INTERVAL_MS = 1_000;
const BOUNDED_BINDING_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/i;

export {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "./session-binding-meta.js";
export const CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS = 60_000;
const BINDING_LEASE_STALE_MS = CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS + 5_000;
const BINDING_LEASE_WAIT_MS = BINDING_LEASE_STALE_MS + 5_000;
const BINDING_LEASE_RENEW_INTERVAL_MS = Math.floor(BINDING_LEASE_STALE_MS / 3);
// Physical session keys cannot have a successor generation. Retain their
// retirement fence only long enough for bounded stale lease work to drain.
const PHYSICAL_SESSION_RETIRE_TTL_MS = BINDING_LEASE_WAIT_MS;

export type CodexRunSessionBindingAuthority = "current" | "ephemeral" | "superseded";

/** Decides whether a run may share the durable stable-key binding owner. */
export function resolveCodexRunSessionBindingAuthority(params: {
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  config?: OpenClawConfig;
  storePath?: string;
}): CodexRunSessionBindingAuthority {
  return captureNativeSessionGenerationAuthority({
    ...params,
    target: params.identity,
    createSupersededError: createCodexSessionGenerationSupersededError,
  }).state;
}

/** Builds the terminal coordination error used when a newer OpenClaw session owns the binding. */
export function createCodexSessionGenerationSupersededError(
  sessionId: string,
): AgentHarnessSessionSupersededError {
  return new AgentHarnessSessionSupersededError(
    `Codex session generation is no longer current: ${sessionId}`,
  );
}

type CodexAppServerBindingMutation =
  | {
      kind: "record-native-subagent-submission";
      owner: CodexNativeSubagentHistoryOwner;
      receipt: CodexNativeSubagentSubmission;
    }
  | {
      kind: "consume-native-subagent-submission";
      owner: CodexNativeSubagentHistoryOwner;
      receipt: CodexNativeSubagentSubmission;
    }
  | {
      kind: "set";
      binding: CodexAppServerThreadBinding;
      if?: { kind: "absent" };
    }
  | {
      kind: "patch";
      threadId: string;
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
    };

export type CodexSessionGenerationRetirementResult = "applied" | "absent" | "conflict";

export function hashCodexAppServerBindingFingerprint(canonical: string): string {
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function normalizeLegacyBindingFingerprint(value: unknown): unknown {
  if (
    typeof value !== "string" ||
    value === "" ||
    value === "[]" ||
    BOUNDED_BINDING_FINGERPRINT_PATTERN.test(value)
  ) {
    return value;
  }
  return hashCodexAppServerBindingFingerprint(value);
}

function normalizeLegacyBindingFingerprints<
  T extends {
    dynamicToolsFingerprint?: unknown;
    userMcpServersFingerprint?: unknown;
  },
>(record: T): T {
  // Shipped sidecars can contain unbounded canonical JSON fingerprints. Bound
  // them at the legacy encoder so plugin-state registration cannot reject the row.
  let normalized = record;
  for (const key of ["dynamicToolsFingerprint", "userMcpServersFingerprint"] as const) {
    const value = record[key];
    const next = normalizeLegacyBindingFingerprint(value);
    if (next === value) {
      continue;
    }
    if (normalized === record) {
      normalized = { ...record };
    }
    Object.assign(normalized, { [key]: next });
  }
  return normalized;
}

export function normalizeStoredCodexAppServerBindingFingerprints(
  value: unknown,
): StoredCodexAppServerBinding | undefined {
  const stored = readStoredCodexAppServerBinding(value);
  if (!stored || stored.state !== "active") {
    return stored;
  }
  const binding = normalizeLegacyBindingFingerprints(stored.binding);
  return binding === stored.binding
    ? stored
    : readStoredCodexAppServerBinding({ ...stored, binding });
}

/** Encodes a migrated sidecar binding as one canonical plugin-state row. */
export function createStoredCodexAppServerBinding(
  value: unknown,
  options: {
    now?: string;
    lookup?: Omit<CodexAppServerAuthProfileLookup, "authProfileId">;
  } = {},
): Extract<StoredCodexAppServerBinding, { state: "active" }> | undefined {
  const rawRecord = asOptionalRecord(value);
  if (!rawRecord) {
    return undefined;
  }
  const record = normalizeLegacyBindingFingerprints(rawRecord);
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    return undefined;
  }
  const pluginAppPolicyContext = readPluginAppPolicyContext(
    record.pluginAppPolicyContext,
    record.schemaVersion,
  );
  const historyCoveredThrough =
    readCodexBindingTimestamp(record.historyCoveredThrough) ??
    readCodexBindingTimestamp(record.updatedAt) ??
    readCodexBindingTimestamp(record.createdAt) ??
    readCodexBindingTimestamp(options.now) ??
    new Date().toISOString();
  const authProfileId = typeof record.authProfileId === "string" ? record.authProfileId : undefined;
  const binding = readCodexAppServerThreadBinding({
    ...record,
    modelProvider: normalizeCodexAppServerBindingModelProvider({
      ...options.lookup,
      authProfileId,
      modelProvider: typeof record.modelProvider === "string" ? record.modelProvider : undefined,
    }),
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    pluginAppPolicyContext,
    historyCoveredThrough,
  });
  return binding
    ? {
        version: 1,
        state: "active",
        binding: stripUndefinedBinding(binding),
      }
    : undefined;
}

export type CodexBindingStateStore = NativeSessionBindingStateStore<StoredCodexAppServerBinding> &
  Pick<PluginStateSyncKeyedStore<StoredCodexAppServerBinding>, "entries" | "lookupMany">;

function bindingLeaseLostError(key: string, cause?: unknown): Error {
  return new Error(`Lost Codex binding lease: ${key}`, cause === undefined ? undefined : { cause });
}

export type CodexAppServerBindingStore = {
  /** Durable ownership rows kept separate from replaceable session bindings. */
  managedThreads?: CodexManagedThreadStore;
  read(identity: CodexAppServerBindingIdentity): CodexAppServerThreadBinding | undefined;
  /** Available when the host provides positional bulk state reads. */
  readMany?: (
    identities: readonly CodexAppServerBindingIdentity[],
  ) => Generator<CodexAppServerThreadBinding | undefined, undefined, void>;
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
  ): Promise<boolean>;
  prepareSessionGenerationReclaim(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
  ): Promise<NativeSessionGenerationReclaimPlan>;
  adoptSessionGeneration(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
    expectedPreviousSessionId: string,
    assertCurrent?: () => void,
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
  withLease<T>(identity: CodexAppServerBindingIdentity, run: () => Promise<T>): Promise<T>;
};

type CodexSessionGenerationReclaimParams = {
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  config?: OpenClawConfig;
  storePath?: string;
  assertCurrent?: () => void;
  onHostGenerationVerified?: (assertHostGeneration: () => void) => void;
  bindingStore: CodexAppServerBindingStore;
  reclaimStale?: boolean;
};

/** Lets the authoritative OpenClaw session generation claim a stale stable binding row. */
export async function reclaimCurrentCodexSessionGeneration(
  params: CodexSessionGenerationReclaimParams,
): Promise<boolean> {
  return await reclaimNativeSessionGeneration({
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
}): Promise<{
  binding: CodexAppServerThreadBinding | undefined;
  assertCurrent: () => void;
}> {
  const identity = params.identity;
  return await resolveNativeSessionBinding({
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
    readRecord: readStoredCodexAppServerBinding,
    lease: {
      staleMs: BINDING_LEASE_STALE_MS,
      waitMs: BINDING_LEASE_WAIT_MS,
      retryIntervalMs: BINDING_LEASE_RETRY_INTERVAL_MS,
      renewIntervalMs: BINDING_LEASE_RENEW_INTERVAL_MS,
    },
    releaseTtlMs: (key, current) =>
      current.state === "active" || (current.retired === true && !key.startsWith("session:"))
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
    options: { allowRetired?: boolean; assertCurrent?: () => void } = {},
  ): NativeSessionBindingLeaseOptions<StoredCodexAppServerBinding> => ({
    assertCurrent: options.assertCurrent,
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
              ...(current.lease && current.lease.token === leaseToken
                ? { lease: current.lease }
                : {}),
            },
          };
        },
        ttlMs,
      );
    });
  };

  return {
    read: (identity) => readCurrentCodexAppServerBinding(state, identity),
    ...(state.lookupMany
      ? {
          readMany: (identities: readonly CodexAppServerBindingIdentity[]) =>
            readCurrentCodexAppServerBindings(state, identities),
        }
      : {}),
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
        if (stored.state !== "active" || stored.binding.threadId !== threadId || isCurrentOwner) {
          return false;
        }
        return true;
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

    async mutate(identity, mutation, assertCurrent) {
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
              mutation.kind === "record-native-subagent-submission" ||
              mutation.kind === "consume-native-subagent-submission"
            ) {
              if (!assertCurrent) {
                throw new Error(
                  "Codex native subagent submission mutation requires current authority.",
                );
              }
              assertCurrent();
              if (
                current?.state !== "active" ||
                !ownsStoredSessionGeneration(identity, current) ||
                (identity.kind === "session" && mutation.owner.sessionId !== identity.sessionId) ||
                !matchesCodexNativeSubagentSubmissionBinding(current.binding, mutation.owner)
              ) {
                return { result: false };
              }
              const changed = mutateCodexNativeSubagentSubmissions({
                current: current.nativeSubagentSubmissions,
                owner: mutation.owner,
                receipt: mutation.receipt,
                consume: mutation.kind === "consume-native-subagent-submission",
              });
              if (!changed.applied) {
                return { result: false };
              }
              const { nativeSubagentSubmissions: _previous, ...bindingOwner } = current;
              return {
                result: true,
                next: {
                  ...bindingOwner,
                  ...(changed.next ? { nativeSubagentSubmissions: changed.next } : {}),
                },
              };
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
                  current.state === "cleared" &&
                  current.retired === true &&
                  current.sessionId === mutation.expectedPreviousSessionId
                ) {
                  // Reset boundaries now retain the OpenClaw session id. The
                  // authoritative session-store check above proves this fence
                  // belongs to the previous in-place lifecycle, not live work.
                  return {
                    result: true,
                    next: {
                      version: 1,
                      state: "cleared",
                      sessionId: identity.sessionId,
                      ...ownedLease,
                    },
                  };
                }
                return {
                  result: current.state !== "cleared" || current.retired !== true,
                };
              }
              if (current.sessionId !== mutation.expectedPreviousSessionId) {
                return { result: false };
              }
              // A stale physical generation must never turn private user-home ownership into
              // an ordinary empty binding. Supervision adoption has an explicit generation
              // transfer path; every other successor fails closed and preserves this owner.
              if (current.state === "active" && current.binding.connectionScope === "supervision") {
                return { result: false };
              }
              return {
                result: true,
                next: {
                  version: 1,
                  state: "cleared",
                  sessionId: identity.sessionId,
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
                  ...ownedLease,
                },
              };
            }
            let binding: CodexAppServerThreadBinding;
            if (mutation.kind === "set" || mutation.kind === "replace-thread") {
              binding = validateBindingForWrite(mutation.binding);
            } else if (mutation.kind === "patch-pending-supervision-branch") {
              binding = validateBindingForWrite({
                ...active!.binding,
                pendingSupervisionBranch: mutation.pending,
              });
            } else if (mutation.kind === "commit-pending-supervision-branch") {
              binding = validateBindingForWrite({
                ...active!.binding,
                ...mutation.patch,
                threadId: mutation.threadId,
                pendingSupervisionBranch: undefined,
              });
            } else {
              binding = validateBindingForWrite({
                ...active!.binding,
                ...mutation.patch,
                threadId: mutation.threadId,
              });
            }
            const nativeSubagentSubmissions = active
              ? preserveCodexNativeSubagentSubmissions(
                  active.binding,
                  binding,
                  active.nativeSubagentSubmissions,
                )
              : undefined;
            return {
              result: true,
              next: {
                version: 1,
                state: "active",
                binding,
                ...(nativeSubagentSubmissions !== undefined ? { nativeSubagentSubmissions } : {}),
                ...storedSessionGeneration(identity, current),
                ...ownedLease,
              },
            };
          },
          // Plain clears may expire immediately: a stale generation that re-sets
          // the key afterwards is fenced by ownsStoredSessionGeneration on read
          // and displaced via reclaim-generation; durable stable-key fences come
          // from retireSessionGeneration, not runtime clears.
          mutation.kind === "clear" && !retainLegacyClear && !lifecycle.hasLease(key)
            ? 1
            : undefined,
          assertCurrent,
        );
      });
    },

    async adoptSessionGeneration(identity, expectedPreviousSessionId, assertCurrent) {
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
            const { nativeSubagentSubmissions, ...bindingOwner } = current;
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

    withLease: (identity, run) =>
      lifecycle.withLease(bindingStoreKey(identity), run, prepareLease(identity)),
  };
}

function codexSessionGenerationOperations(
  store: CodexAppServerBindingStore,
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
): NativeSessionGenerationOperations {
  return {
    prepareReclaim: () => store.prepareSessionGenerationReclaim(identity),
    adopt: (expectedPreviousSessionId, assertCurrent) =>
      store.adoptSessionGeneration(identity, expectedPreviousSessionId, assertCurrent),
    reclaim: (expectedPreviousSessionId, assertCurrent) =>
      store.mutate(
        identity,
        { kind: "reclaim-generation", expectedPreviousSessionId },
        assertCurrent,
      ),
  };
}

function matchesPendingSupervisionBranch(
  binding: CodexAppServerThreadBinding | undefined,
  expected: CodexAppServerPendingSupervisionBranch,
): boolean {
  const pending = binding?.pendingSupervisionBranch;
  if (!pending || binding?.threadId !== expected.sourceThreadId) {
    return false;
  }
  if (
    pending.sourceThreadId !== expected.sourceThreadId ||
    pending.connectionFingerprint !== expected.connectionFingerprint ||
    pending.lastTurnId !== expected.lastTurnId
  ) {
    return false;
  }
  const currentCleanup = pending.cleanupThreadIds ?? [];
  const expectedCleanup = expected.cleanupThreadIds ?? [];
  return (
    currentCleanup.length === expectedCleanup.length &&
    currentCleanup.every((threadId, index) => threadId === expectedCleanup[index])
  );
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

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
