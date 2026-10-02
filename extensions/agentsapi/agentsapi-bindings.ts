import type {
  AgentHarnessSessionDeletionMutation,
  AgentHarnessSessionDeletionParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createNativeSessionBindingLifecycle } from "openclaw/plugin-sdk/agent-harness-session-runtime";
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
  executorCleanup?: {
    settle: (
      localSessionId: string,
      binding: AgentsApiBinding,
      assertCurrent: () => void,
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
    async reset(localSessionId: string, assertCurrent: () => void): Promise<void> {
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
            if (binding?.executor) {
              if (!executorCleanup) {
                throw new Error("Agents API self-hosted executor cleanup is unavailable");
              }
              await executorCleanup.settle(localSessionId, binding, assertResetCurrent);
              assertResetCurrent();
              await executorCleanup.retire(localSessionId, binding, assertResetCurrent);
              assertResetCurrent();
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
    async withSessionDeletion<T>(
      params: AgentHarnessSessionDeletionParams,
      run: (mutation: AgentHarnessSessionDeletionMutation) => Promise<T>,
    ): Promise<T> {
      return await lifecycle.withDeletion(
        params.sessionId,
        {
          ...acquisition(params.assertCurrent),
          assertRecordCurrent: () => params.assertCurrent(),
        },
        async (stored, mutation) => {
          const binding = nativeBinding(stored);
          if (binding?.executor) {
            const assertLeaseCurrent = lifecycle.captureLeaseAssertion(params.sessionId);
            const assertDeletionCurrent = () => {
              params.assertCurrent();
              assertLeaseCurrent();
            };
            const cleanup = executorCleanup;
            if (!cleanup) {
              throw new Error("Agents API self-hosted executor cleanup is unavailable");
            }
            await cleanup.settle(params.sessionId, binding, assertDeletionCurrent);
            assertDeletionCurrent();
            // Retain the binding until retirement succeeds; rollback can reconnect it.
            await cleanup.retire(params.sessionId, binding, assertDeletionCurrent);
            assertDeletionCurrent();
          }
          return await run(mutation);
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
