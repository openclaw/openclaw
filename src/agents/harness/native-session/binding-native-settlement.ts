import { preparePluginStateNativeBindingCodec } from "../../../plugin-state/plugin-state-native-binding-codec.js";
import type { PluginStateNativeBindingPlan } from "../../../plugin-state/plugin-state-native-binding.types.js";
import { runWriteTransaction } from "../../../plugin-state/plugin-state-store.database.js";
import {
  deletePluginStateNativeBinding,
  restorePluginStateNativeBinding,
} from "../../../plugin-state/plugin-state-store.mutations.js";
import type { NativeSessionDeletionParticipant } from "./deletion-participant.js";

/** Initialization, incognito, and mixed released participants still need native atomicity. */
export function createNativeSessionBindingNativeSettlement(params: {
  plan: PluginStateNativeBindingPlan;
  env?: NodeJS.ProcessEnv;
  assertCurrent(): void;
  settle(outcome: "committed" | "rolled-back"): void;
}): NonNullable<NativeSessionDeletionParticipant["nativeMutation"]> {
  let removed: Record<string, unknown> | undefined;
  let prepared = false;
  const assertPrepared = () => {
    params.assertCurrent();
    if (!prepared) {
      throw new Error("Native binding settlement was not selected before the transaction");
    }
  };
  return {
    async prepare() {
      params.assertCurrent();
      await preparePluginStateNativeBindingCodec(params.plan, params.env);
      params.assertCurrent();
      prepared = true;
    },
    commit() {
      assertPrepared();
      if (removed) {
        return;
      }
      const outcome = runWriteTransaction(
        "delete",
        (database) => {
          assertPrepared();
          const result = deletePluginStateNativeBinding(database, params.plan);
          if (result.status === "conflict") {
            throw new Error(params.plan.deletionChanged);
          }
          assertPrepared();
          return result;
        },
        { env: params.env },
      );
      removed = outcome.status === "deleted" ? outcome.value : undefined;
      params.settle("committed");
    },
    rollback() {
      assertPrepared();
      if (!removed) {
        return;
      }
      const value = removed;
      runWriteTransaction(
        "register",
        (database) => {
          assertPrepared();
          if (!restorePluginStateNativeBinding(database, params.plan, value)) {
            throw new Error(params.plan.rollbackChanged);
          }
          assertPrepared();
        },
        { env: params.env },
      );
      removed = undefined;
      params.settle("rolled-back");
    },
  };
}
