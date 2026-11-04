import { warnSessionPersistenceDeprecation } from "../sessions/session-persistence-deprecation.js";
import {
  getNativeSessionDeletionParticipant,
  wrapNativeSessionDeletionMutation,
} from "./native-session/deletion-participant.js";
import { captureAgentHarnessLifecycleHooks } from "./registry-lifecycle.js";
import type {
  AgentHarnessSessionDeletionMutation,
  AgentHarnessSessionDeletionParams,
} from "./types.js";

export type AgentHarnessSessionDeletionTarget = Omit<
  AgentHarnessSessionDeletionParams,
  "assertCurrent"
> & { agentHarnessId?: string; previousSessionId?: string };
export type PreparedAgentHarnessSessionDeletion = AgentHarnessSessionDeletionMutation & {
  assertCurrent: () => void;
};

/** Reuse the registered harness owner; deletion is not a second plugin registration surface. */
export function captureAgentHarnessSessionDeletions() {
  return captureAgentHarnessSessionMutations("withSessionDeletion");
}

export function captureAgentHarnessSessionContextResets() {
  return captureAgentHarnessSessionMutations("withSessionContextReset");
}

function captureAgentHarnessSessionMutations(
  hook: "withSessionDeletion" | "withSessionContextReset",
) {
  const owners = captureAgentHarnessLifecycleHooks(hook);
  return owners.length === 0
    ? undefined
    : async <T>(
        targets: readonly AgentHarnessSessionDeletionTarget[],
        run: (
          prepared: ReadonlyMap<string, readonly PreparedAgentHarnessSessionDeletion[]>,
        ) => Promise<T>,
        assertSourceCurrent?: () => void,
      ): Promise<T> => {
        const pending = targets.flatMap((target) =>
          owners
            .filter(
              ({ registration }) =>
                hook === "withSessionContextReset" ||
                !target.agentHarnessId ||
                target.agentHarnessId === registration.harness.id,
            )
            .map((owner) => ({ owner, target })),
        );
        const prepared = new Map<string, PreparedAgentHarnessSessionDeletion[]>();
        const prepareNext = async (index: number): Promise<T> => {
          const candidate = pending[index];
          if (!candidate) {
            return await run(prepared);
          }
          const { owner, target } = candidate;
          let active = true;
          let preparing = true;
          const assertCurrent = () => {
            if (!active || !owner.isCurrent()) {
              throw new Error(
                `Session mutation harness owner changed: ${owner.registration.harness.id}`,
              );
            }
          };
          const assertEffectCurrent = () => {
            assertCurrent();
            if (preparing) {
              assertSourceCurrent?.();
            }
          };
          try {
            assertEffectCurrent();
            const result = await owner.prepare<T>(
              { ...target, assertCurrent: assertEffectCurrent },
              async (mutation) => {
                assertCurrent();
                if (!getNativeSessionDeletionParticipant(mutation)) {
                  warnSessionPersistenceDeprecation(
                    `AgentHarness.${hook} unbound commit/rollback callbacks`,
                    "createNativeSessionBindingLifecycleV2 or createNativeSessionCommitFinalizer",
                    { pluginId: owner.registration.pluginId, family: "native-session-deletion" },
                  );
                }
                // The transaction now owns forward authority; rollback and terminal
                // cleanup must settle even if that source is subsequently revoked.
                preparing = false;
                const mutations = prepared.get(target.sessionKey) ?? [];
                mutations.push(
                  Object.assign(
                    wrapNativeSessionDeletionMutation(mutation, {
                      assertCurrent,
                      committed() {},
                      rolledBack() {},
                    }),
                    { assertCurrent },
                  ),
                );
                prepared.set(target.sessionKey, mutations);
                return await prepareNext(index + 1);
              },
            );
            assertCurrent();
            return result;
          } finally {
            active = false;
          }
        };
        return await prepareNext(0);
      };
}
