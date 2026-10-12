import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../../plugins/runtime/generation-scope.js";
import { wrapNativeSessionDeletionMutation } from "./native-session/deletion-participant.js";
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
  const scopedRegistry = () =>
    getPluginRuntimeGenerationRegistry() ?? getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scoped = scopedRegistry();
  const registry = scoped ?? getPluginRegistryState()?.activeRegistry;
  const owners =
    registry?.agentHarnesses.flatMap((registration) => {
      const prepare = registration.harness[hook];
      if (!prepare) {
        return [];
      }
      const record = registry.plugins.find((plugin) => plugin.id === registration.pluginId);
      const current =
        record || registration.pluginId === "core"
          ? capturePluginLifecycleAuthority(registry, record, {
              scopedRuntime: scoped === registry,
            })
          : undefined;
      return [{ registration, prepare, current }];
    }) ?? [];
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
            if (
              !active ||
              !owner.current?.() ||
              (scoped && scopedRegistry() !== scoped) ||
              !registry?.agentHarnesses.includes(owner.registration) ||
              owner.registration.harness[hook] !== owner.prepare
            ) {
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
