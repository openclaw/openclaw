import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import type { PluginStateNativeBindingPlan } from "../../../plugin-state/plugin-state-native-binding.types.js";
import { prepareRegisterParams } from "../../../plugin-state/plugin-state-store.validation.js";
import {
  comparePluginStateDeleteInWorker,
  observePluginStateInWorker,
  registerPluginStateIfAbsentInWorker,
} from "../../../plugin-state/plugin-state-worker-client.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { NativeSessionBindingRecord } from "./binding-leases.js";
import type { NativeSessionDeletionParticipant } from "./deletion-participant.js";

/** Memory's FIFO awaits the shared writer, including compensation before releasing the queue. */
export function createNativeSessionBindingMemorySettlement(params: {
  plan: PluginStateNativeBindingPlan;
  context: OpenClawStateWorkerContext;
  env?: NodeJS.ProcessEnv;
  readRecord(value: unknown): NativeSessionBindingRecord | undefined;
  participant: NativeSessionDeletionParticipant;
}) {
  const { plan, participant } = params;
  const scope = {
    pluginId: plan.pluginId,
    namespace: plan.namespace,
    key: plan.key,
    maxEntries: plan.maxEntries,
    overflowPolicy: plan.overflowPolicy,
    context: params.context,
    env: params.env,
  };
  let removed: Record<string, unknown> | undefined;
  const recordUnknown = (error: unknown) => {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      participant.settle("unknown", error instanceof Error ? error : undefined);
    }
    throw error;
  };
  return {
    async commit(assertCurrent: () => void) {
      await participant.joinRenewal();
      participant.quiesce();
      const observed = await observePluginStateInWorker({
        ...scope,
        assertCurrent,
      });
      const parsed = params.readRecord(observed.value);
      const { lease, ...value } = parsed ?? {};
      const assertBindingCurrent = () => {
        assertCurrent();
        if (
          plan.predicate.kind === "absent"
            ? observed.value !== undefined
            : !parsed ||
              lease?.token !== plan.predicate.token ||
              lease.expiresAt <= Date.now() ||
              !isDeepStrictEqual(value, plan.predicate.value)
        ) {
          throw new Error(plan.deletionChanged);
        }
      };
      try {
        const result = await comparePluginStateDeleteInWorker({
          ...scope,
          assertCurrent: assertBindingCurrent,
          comparison: observed.comparison,
          operation: "delete",
          action: plan.predicate.kind === "absent" ? "keep" : "delete",
        });
        if (result.status === "conflict") {
          throw new Error(plan.deletionChanged);
        }
        removed = asOptionalRecord(observed.value);
        participant.settle("committed");
      } catch (error) {
        recordUnknown(error);
      }
    },
    async rollback(assertCurrent: () => void) {
      if (participant.unknown) {
        return;
      }
      if (removed && plan.predicate.kind === "leased") {
        try {
          const restored = {
            ...removed,
            lease: { token: plan.predicate.token, expiresAt: Date.now() + plan.staleMs },
          };
          if (
            !(await registerPluginStateIfAbsentInWorker({
              ...scope,
              assertCurrent,
              ...prepareRegisterParams(plan.key, restored, plan.ttlMs),
            }))
          ) {
            throw new Error(plan.rollbackChanged);
          }
          removed = undefined;
        } catch (error) {
          recordUnknown(error);
        }
      }
      participant.settle("rolled-back");
    },
  };
}
