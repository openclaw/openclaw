import type { DatabasePathIdentity } from "../../../infra/sqlite-worker-identity.js";
import type { PluginStateNativeBindingPlan } from "../../../plugin-state/plugin-state-native-binding.types.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import type { AgentHarnessSessionDeletionMutation } from "../types.js";

export type NativeSessionDeletionParticipant = {
  binding?: PluginStateNativeBindingPlan;
  source?: DatabasePathIdentity;
  assertCurrent(): void;
  renewalPending(): boolean;
  joinRenewal(): Promise<void>;
  quiesce(): void;
  retain(custody: object): void;
  settle(outcome: "committed" | "rolled-back" | "unknown", error?: Error): void;
  unknown: boolean;
};

const participants = resolveGlobalSingleton(
  Symbol.for("openclaw.nativeSessionDeletionParticipants"),
  () => new WeakMap<AgentHarnessSessionDeletionMutation, NativeSessionDeletionParticipant>(),
);

export function bindNativeSessionDeletionParticipant(
  mutation: AgentHarnessSessionDeletionMutation,
  participant: NativeSessionDeletionParticipant,
) {
  participants.set(mutation, participant);
  return mutation;
}

export function getNativeSessionDeletionParticipant(mutation: AgentHarnessSessionDeletionMutation) {
  return participants.get(mutation);
}

/** Preserve the audited participant when a harness adds live authority and commit-only facts. */
export function wrapNativeSessionDeletionMutation(
  mutation: AgentHarnessSessionDeletionMutation,
  hooks: { assertCurrent(): void; committed(): void; rolledBack(): void },
): AgentHarnessSessionDeletionMutation {
  const wrapped: AgentHarnessSessionDeletionMutation = {
    commit() {
      hooks.assertCurrent();
      mutation.commit();
      hooks.committed();
    },
    rollback() {
      hooks.assertCurrent();
      mutation.rollback();
      hooks.rolledBack();
    },
  };
  const participant = participants.get(mutation);
  if (participant) {
    // An unresolved binding must keep the outer exact-client cleanup owner reachable.
    participant.retain(hooks);
    participants.set(wrapped, {
      ...participant,
      assertCurrent() {
        participant.assertCurrent();
        hooks.assertCurrent();
      },
      settle(outcome, error) {
        participant.settle(outcome, error);
        if (outcome === "committed") {
          hooks.committed();
        }
        if (outcome === "rolled-back") {
          hooks.rolledBack();
        }
      },
      get unknown() {
        return participant.unknown;
      },
    });
  }
  return wrapped;
}

/** ACP has no reversible storage effect; its finalizer becomes eligible only after A COMMIT. */
export function createNativeSessionCommitFinalizer(mutation: AgentHarnessSessionDeletionMutation) {
  const custody = new Set<object>();
  return bindNativeSessionDeletionParticipant(mutation, {
    assertCurrent() {},
    renewalPending: () => false,
    async joinRenewal() {},
    quiesce() {},
    retain: (owner) => {
      custody.add(owner);
    },
    unknown: false,
    settle(outcome) {
      this.unknown = outcome === "unknown";
      if (outcome === "committed") {
        mutation.commit();
      }
      if (outcome === "rolled-back") {
        mutation.rollback();
      }
    },
  });
}

export function isNativeSessionDeletionUnresolved(mutation: AgentHarnessSessionDeletionMutation) {
  return participants.get(mutation)?.unknown === true;
}
