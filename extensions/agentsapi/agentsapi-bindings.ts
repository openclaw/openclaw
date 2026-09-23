import type {
  AgentHarnessSessionDeletionMutation,
  AgentHarnessSessionDeletionParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createNativeSessionBindingLifecycle } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { z } from "zod";

export type AgentsApiBinding = { sessionId: string; authFingerprint: string };

/** Native identity is plugin-owned; shared runtime owns mutation and lease coordination. */
export function createAgentsApiBindings(runtime: PluginRuntime) {
  const state = runtime.state.openSyncKeyedStore<StoredBinding>({
    namespace: "agentsapi-sessions",
    maxEntries: 100_000,
    overflowPolicy: "reject-new",
  });
  const lifecycle = createNativeSessionBindingLifecycle(state, {
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
      conditionalDeletionRequired: "Agents API deletion requires conditional plugin-state deletion",
      deletionChanged: "Agents API binding changed before session deletion",
      rollbackChanged: "Agents API binding changed before session deletion rollback",
    },
  });
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
    lookup(localSessionId: string): AgentsApiBinding | undefined {
      return nativeBinding(readRecord(state.lookup(localSessionId)));
    },
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
        (_binding, mutation) => run(mutation),
      );
    },
  };
}

const bindingSchema = z.object({
  sessionId: z.string().min(1),
  authFingerprint: z.string().min(1),
});
const storedBindingSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    authFingerprint: z.string().min(1).optional(),
    lease: z.object({ token: z.string().min(1), expiresAt: z.number().finite() }).optional(),
  })
  .refine((row) => (row.sessionId === undefined) === (row.authFingerprint === undefined));
type StoredBinding = z.infer<typeof storedBindingSchema>;

function readRecord(raw: unknown): StoredBinding | undefined {
  const result = storedBindingSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

function nativeBinding(row: StoredBinding | undefined): AgentsApiBinding | undefined {
  return row?.sessionId && row.authFingerprint
    ? { sessionId: row.sessionId, authFingerprint: row.authFingerprint }
    : undefined;
}
