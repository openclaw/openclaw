import type {
  AgentHarnessSessionDeletionMutation,
  AgentHarnessSessionDeletionParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createNativeSessionBindingLifecycle,
  isNativeSessionDeletionUnresolved,
  wrapNativeSessionDeletionMutation,
} from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  bindingSchema,
  readRecord,
  type AgentsApiBinding,
  type StoredBinding,
} from "./agentsapi-binding-record.js";

export type { AgentsApiBinding } from "./agentsapi-binding-record.js";

/** Native identity is plugin-owned; shared runtime owns mutation and lease coordination. */
export function createAgentsApiBindings(
  runtime: PluginRuntime,
  nativeCleanup?: {
    settle: (
      localSessionId: string,
      binding: AgentsApiBinding,
      assertCurrent: () => void,
      agentId?: string,
    ) => Promise<void>;
    retire: (
      localSessionId: string,
      binding: AgentsApiBinding,
      assertCurrent: () => void,
    ) => Promise<void>;
  },
) {
  const stateOptions = {
    namespace: "agentsapi-sessions",
    maxEntries: 100_000,
    overflowPolicy: "reject-new" as const,
  };
  const state = runtime.state.openSyncKeyedStore<StoredBinding>(stateOptions);
  const mutationState = runtime.state.openKeyedStore<StoredBinding>(stateOptions);
  const lifecycle = createNativeSessionBindingLifecycle(
    {
      lookup: state.lookup.bind(state),
      deleteIf: state.deleteIf?.bind(state),
      registerIfAbsent: state.registerIfAbsent.bind(state),
      withCurrent(authority) {
        if (!mutationState.withCurrent) {
          throw new Error("Agents API bindings require action-bound plugin-state mutations");
        }
        return mutationState.withCurrent(authority);
      },
    },
    {
      workerCodec: "agentsapi",
      readRecord,
      lease: {
        staleMs: 65_000,
        waitMs: 70_000,
        retryIntervalMs: 1_000,
        renewIntervalMs: 21_000,
      },
      // Reset removes the old binding; keep an empty row only until its lease releases.
      releaseTtlMs: (_key, current) => (current.sessionId ? undefined : 1),
      errors: {
        atomicUpdatesRequired: "Agents API bindings require atomic plugin-state updates",
        invalidRow: (key) => new Error(`Invalid Agents API binding row: ${key}`),
        lostLease: (key, cause) => new Error(`Agents API binding lease lost: ${key}`, { cause }),
        leaseTimeout: (key) => new Error(`Timed out waiting for Agents API binding lease: ${key}`),
        acquisitionRejected: (key) => new Error(`Agents API binding acquisition rejected: ${key}`),
        mutationBlocked: "Agents API binding mutation blocked during an exclusive operation",
        conditionalDeletionRequired:
          "Agents API deletion requires conditional plugin-state deletion",
        deletionChanged: "Agents API binding changed before session deletion",
        rollbackChanged: "Agents API binding changed before session deletion rollback",
      },
    },
  );
  const acquisition = (assertCurrent: () => void) => ({
    assertCurrent,
    prepareLease: (
      current: StoredBinding | undefined,
      lease: NonNullable<StoredBinding["lease"]>,
    ) => ({
      ...current,
      lease,
    }),
  });

  return {
    withExclusiveMutationFence: lifecycle.withExclusiveMutationFence,
    async withSession<T>(
      localSessionId: string,
      assertCurrent: () => void,
      run: (
        binding: AgentsApiBinding | undefined,
        bind: (binding: AgentsApiBinding) => Promise<void>,
        assertLeaseCurrent: () => void,
      ) => Promise<T>,
    ): Promise<T> {
      return await lifecycle.withMutation(() =>
        lifecycle.withLease(
          localSessionId,
          async () => {
            assertCurrent();
            const assertLeaseCurrent = lifecycle.captureLeaseAssertion(localSessionId);
            let active = true;
            const bind = async (binding: AgentsApiBinding) => {
              assertCurrent();
              if (!active) {
                throw new Error("Agents API binding operation is no longer active");
              }
              assertLeaseCurrent();
              const validated = bindingSchema.parse(binding);
              await lifecycle.transact(
                localSessionId,
                (current) => ({
                  next: { ...validated, ...(current?.lease ? { lease: current.lease } : {}) },
                  result: undefined,
                }),
                undefined,
                assertCurrent,
              );
              assertCurrent();
            };
            try {
              return await run(
                nativeBinding(readRecord(state.lookup(localSessionId))),
                bind,
                assertLeaseCurrent,
              );
            } finally {
              active = false;
            }
          },
          acquisition(assertCurrent),
        ),
      );
    },
    async reset(
      localSessionId: string,
      assertCurrent: () => void,
      agentId?: string,
    ): Promise<void> {
      await lifecycle.withMutation(() =>
        lifecycle.withLease(
          localSessionId,
          async () => {
            const assertLeaseCurrent = lifecycle.captureLeaseAssertion(localSessionId);
            const assertResetCurrent = () => {
              assertCurrent();
              assertLeaseCurrent();
            };
            const binding = nativeBinding(readRecord(state.lookup(localSessionId)));
            if (binding) {
              if (!nativeCleanup) {
                throw new Error("Agents API native session cleanup is unavailable");
              }
              await nativeCleanup.settle(localSessionId, binding, assertResetCurrent, agentId);
              assertResetCurrent();
              if (binding.executor) {
                await nativeCleanup.retire(localSessionId, binding, assertResetCurrent);
                assertResetCurrent();
              }
            }
            await lifecycle.transact(
              localSessionId,
              (current) => ({
                next: current?.lease ? { lease: current.lease } : {},
                result: undefined,
              }),
              undefined,
              assertCurrent,
            );
          },
          acquisition(assertCurrent),
        ),
      );
    },
    resolveContextResetSessionId(sessionId: string, previousSessionId?: string): string {
      // Only the host-recorded predecessor can retain a binding across a history cut.
      const raw = state.lookup(sessionId);
      const current = readRecord(raw);
      if (raw !== undefined && !current) {
        throw new Error(`Invalid Agents API binding row: ${sessionId}`);
      }
      return current?.sessionId || !previousSessionId ? sessionId : previousSessionId;
    },
    async withSessionDeletion<T>(
      params: AgentHarnessSessionDeletionParams,
      run: (mutation: AgentHarnessSessionDeletionMutation) => Promise<T>,
      retireAfterCommit = false,
    ): Promise<T> {
      return await lifecycle.withDeletion(
        params.sessionId,
        {
          ...acquisition(params.assertCurrent),
          assertRecordCurrent: () => params.assertCurrent(),
        },
        async (stored, mutation) => {
          const binding = nativeBinding(stored);
          if (binding) {
            const assertLeaseCurrent = lifecycle.captureLeaseAssertion(params.sessionId);
            const assertDeletionCurrent = () => {
              params.assertCurrent();
              assertLeaseCurrent();
            };
            const cleanup = nativeCleanup;
            if (!cleanup) {
              throw new Error("Agents API native session cleanup is unavailable");
            }
            await cleanup.settle(params.sessionId, binding, assertDeletionCurrent, params.agentId);
            assertDeletionCurrent();
            if (binding.executor && !retireAfterCommit) {
              // Give the controller a chance to stop its executor before deleting the binding.
              await cleanup.retire(params.sessionId, binding, assertDeletionCurrent);
              assertDeletionCurrent();
            }
          }
          if (!retireAfterCommit || !binding?.executor) {
            return await run(mutation);
          }
          let committed = false;
          try {
            return await run(
              wrapNativeSessionDeletionMutation(mutation, {
                assertCurrent: params.assertCurrent,
                committed: () => {
                  committed = true;
                },
                rolledBack: () => {
                  committed = false;
                },
              }),
            );
          } finally {
            // A rejected/rolled-back cut keeps its executor. After confirmed commit
            // the removed binding is captured here; its deleted lease cannot authorize
            // cleanup, so only this still-active host mutation retains that custody.
            if (committed && !isNativeSessionDeletionUnresolved(mutation)) {
              params.assertCurrent();
              await nativeCleanup!.retire(params.sessionId, binding, params.assertCurrent);
              params.assertCurrent();
            }
          }
        },
      );
    },
  };
}

function nativeBinding(row: StoredBinding | undefined): AgentsApiBinding | undefined {
  return row?.sessionId && row.configFingerprint
    ? {
        sessionId: row.sessionId,
        configFingerprint: row.configFingerprint,
        executorControllerPluginId: row.executorControllerPluginId,
        executor: row.executor,
      }
    : undefined;
}
