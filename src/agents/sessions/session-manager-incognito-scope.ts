import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { SessionActor } from "../../config/sessions/session-actor-contract.js";
import {
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import type {
  SessionActorStorageAuthority,
  SessionActorStorage,
} from "../../config/sessions/session-actor-storage-contract.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionBinding,
  type IncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptActor,
} from "../../config/sessions/transcript-write-context.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { isActiveStoreWriter } from "../../shared/store-writer-queue.js";
import { IncognitoSessionSyncAccessError } from "../../state/incognito-session-error.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission-state.js";
import { warnSessionPersistenceDeprecation } from "./session-persistence-deprecation.js";

export type SessionManagerMemoryBinding = Readonly<{
  kind: "memory";
  actor: SessionActor;
  storage: SessionActorStorage;
  authority: SessionActorStorageAuthority;
  database: Readonly<OpenClawAgentDatabaseOptions & { agentId: string; path: string }>;
  target: SessionTranscriptRuntimeTarget;
}>;

type SessionManagerIncognitoBinding = IncognitoSessionBinding | SessionManagerMemoryBinding;

const managerBindings = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionManagerIncognitoBindings"),
  () => new WeakMap<object, SessionManagerIncognitoBinding>(),
);

const activeMemoryBindings = new AsyncLocalStorage<
  ReadonlyMap<object, SessionManagerMemoryBinding>
>();

/** Accepted nested writes use the phase's retained handle while release drains the manager. */
export function withSessionManagerMemoryBinding<T>(
  manager: object,
  binding: SessionManagerMemoryBinding,
  operation: () => T,
): T {
  const active = new Map(activeMemoryBindings.getStore());
  active.set(manager, binding);
  return activeMemoryBindings.run(active, () =>
    runWithSessionActorStorage(
      {
        actor: binding.actor,
        authority: binding.authority,
        agentId: binding.database.agentId,
        path: binding.database.path,
      },
      operation,
    ),
  );
}

export function captureSessionManagerIncognitoBinding(
  target: SessionTranscriptRuntimeTarget | undefined,
  manager?: object,
  retarget = false,
): SessionManagerIncognitoBinding | undefined {
  const retained = manager
    ? (activeMemoryBindings.getStore()?.get(manager) ?? managerBindings.get(manager))
    : undefined;
  if (!target) {
    return undefined;
  }
  if (retarget || !retained) {
    const injected = getSessionActorStorageBinding(target);
    const selected = injected
      ? {
          actor: injected.actor,
          database: { agentId: injected.agentId, path: injected.path, env: target.env },
        }
      : getOwnedSessionTranscriptActor(target);
    if (selected?.actor.target.database.kind === "memory") {
      const storage = selected.actor.storage;
      if (!storage) {
        throw new Error("Memory session actor has no storage capability");
      }
      const assertCurrent = captureOwnedTranscriptWriteAssertion(target);
      return {
        kind: "memory",
        ...selected,
        storage,
        target,
        authority: injected?.authority ?? { assertCurrent, authorize() {} },
      };
    }
    const scoped = captureIncognitoSessionBinding(target);
    if (scoped) {
      return scoped;
    }
  }
  if (retained && "kind" in retained) {
    if (!sameSessionTranscriptTargetBinding(retained.target, target)) {
      throw new Error("Session manager target differs from its selected memory actor");
    }
    return retained;
  }
  return retained
    ? withIncognitoSessionBinding(retained, () => captureIncognitoSessionBinding(target))
    : undefined;
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
  return binding && !("kind" in binding)
    ? withIncognitoSessionBinding(binding, operation)
    : operation();
}

export function captureSessionManagerIncognitoAdmissionAssertion(
  binding: SessionManagerIncognitoBinding,
): () => void {
  if ("kind" in binding) {
    return () => binding.actor.assertAdmission?.();
  }
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
