import { AsyncLocalStorage } from "node:async_hooks";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { IncognitoSessionActor } from "../../config/sessions/session-incognito-actor.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { isActiveStoreWriter } from "../../shared/store-writer-queue.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission.js";

export type SessionManagerIncognitoBinding = Readonly<{
  actor: IncognitoSessionActor;
  admissionSignal?: AbortSignal;
}>;

const managerBindings = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionManagerIncognitoBindings"),
  () => new WeakMap<object, SessionManagerIncognitoBinding>(),
);

const actorScope = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionManagerIncognitoActor"),
  () => new AsyncLocalStorage<SessionManagerIncognitoBinding>(),
);

/**
 * Inactive composition entry point; P7d will install the captured actor at runtime admission.
 * @internal Knip production exception; P7d removes this tag when it installs the runtime caller.
 */
export function withSessionManagerIncognitoActor<T>(
  actor: IncognitoSessionActor,
  operation: () => Promise<T>,
  admissionSignal?: AbortSignal,
): Promise<T> {
  actor.assertCurrent();
  admissionSignal?.throwIfAborted();
  return actor.sessions.withSharedState(() =>
    actorScope.run({ actor, admissionSignal }, operation),
  );
}

export function captureSessionManagerIncognitoBinding(
  target: SessionTranscriptRuntimeTarget | undefined,
  manager?: object,
  retarget = false,
): SessionManagerIncognitoBinding | undefined {
  const retained = manager ? managerBindings.get(manager) : undefined;
  const scoped = actorScope.getStore();
  const binding = retarget ? (scoped ?? retained) : (retained ?? scoped);
  const actor = binding?.actor;
  if (!actor || !isIncognitoSessionKey(target?.sessionKey)) {
    return undefined;
  }
  actor.assertCurrent();
  if (
    !target ||
    target.agentId !== actor.agentId ||
    resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteTranscriptReadScope(target))) !==
      actor.path
  ) {
    throw new Error("SessionManager target belongs to another incognito actor");
  }
  return binding;
}

/** Publish the binding captured by preparation; failed hydration never changes its owner. */
export function installSessionManagerIncognitoBinding(
  manager: object,
  binding: SessionManagerIncognitoBinding | undefined,
): void {
  if (binding) {
    binding.actor.assertCurrent();
    managerBindings.set(manager, binding);
  } else {
    managerBindings.delete(manager);
  }
}

export function withRetainedSessionManagerIncognitoActor<T>(
  manager: object,
  operation: () => T,
): T {
  const binding = managerBindings.get(manager);
  return binding ? actorScope.run(binding, operation) : operation();
}

export function captureSessionManagerIncognitoAdmissionAssertion(
  binding: SessionManagerIncognitoBinding,
): () => void {
  // Accepted writes retain their hydration and settlement after new admission closes.
  const acceptedWriter = isActiveStoreWriter(SQLITE_SESSION_WRITER_QUEUES, binding.actor.path);
  const signals = [
    binding.admissionSignal,
    actorScope.getStore()?.admissionSignal,
    getAsyncWorkSignal(),
  ];
  return () => {
    if (!acceptedWriter) {
      for (const signal of signals) {
        signal?.throwIfAborted();
      }
    }
  };
}

export function assertSessionManagerIncognitoAdmission(
  binding: SessionManagerIncognitoBinding,
): void {
  captureSessionManagerIncognitoAdmissionAssertion(binding)();
}
