import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionBinding,
  type IncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { isActiveStoreWriter } from "../../shared/store-writer-queue.js";
import { IncognitoSessionSyncAccessError } from "../../state/incognito-session-error.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission-state.js";
import { warnSessionPersistenceDeprecation } from "./session-persistence-deprecation.js";

const managerBindings = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionManagerIncognitoBindings"),
  () => new WeakMap<object, IncognitoSessionBinding>(),
);

export function captureSessionManagerIncognitoBinding(
  target: SessionTranscriptRuntimeTarget | undefined,
  manager?: object,
  retarget = false,
): IncognitoSessionBinding | undefined {
  const retained = manager ? managerBindings.get(manager) : undefined;
  if (!target) {
    return undefined;
  }
  if (retarget || !retained) {
    const scoped = captureIncognitoSessionBinding(target);
    if (scoped) {
      return scoped;
    }
  }
  return retained
    ? withIncognitoSessionBinding(retained, () => captureIncognitoSessionBinding(target))
    : undefined;
}

/** Publish the binding captured by preparation; failed hydration never changes its owner. */
export function installSessionManagerIncognitoBinding(
  manager: object,
  binding: IncognitoSessionBinding | undefined,
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
  return binding ? withIncognitoSessionBinding(binding, operation) : operation();
}

export function captureSessionManagerIncognitoAdmissionAssertion(
  binding: IncognitoSessionBinding,
): () => void {
  // Accepted writes retain their hydration and settlement after new admission closes.
  const acceptedWriter = isActiveStoreWriter(SQLITE_SESSION_WRITER_QUEUES, binding.actor.path);
  const signals = [
    binding.admissionSignal,
    captureIncognitoSessionBinding()?.admissionSignal,
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

/** Preflight the synchronous SDK entry before warnings, local mutation, or native SQLite. */
export function prepareSessionManagerSync(
  method: string,
  target: SessionTranscriptRuntimeTarget | undefined,
  manager?: object,
  replacement = `${method}Async`,
): void {
  const qualified = `SessionManager.${method}`;
  const binding =
    (manager ? managerBindings.get(manager) : undefined) ??
    captureSessionManagerIncognitoBinding(target, manager);
  if (binding) {
    binding.actor.assertCurrent();
    throw new IncognitoSessionSyncAccessError(qualified, replacement);
  }
  warnSessionPersistenceDeprecation(qualified, replacement);
}
