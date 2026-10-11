import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type {
  SessionActor,
  SessionActorStorage,
} from "../../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import {
  acquireSessionActorStorage,
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "../../config/sessions/session-actor-storage-contract.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptActor,
} from "../../config/sessions/transcript-write-context.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { IncognitoSessionSyncAccessError } from "../../state/incognito-session-error.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { warnSessionPersistenceDeprecation } from "./session-persistence-deprecation.js";

export type SessionManagerMemoryBinding = Readonly<{
  kind: "memory";
  authority: SessionActorStorageAuthority;
  database: Readonly<OpenClawAgentDatabaseOptions & { agentId: string; path: string }>;
  target: SessionTranscriptRuntimeTarget;
  acquire(create: boolean): Promise<SessionActor | undefined>;
}>;

export type ActiveSessionManagerMemoryBinding = SessionManagerMemoryBinding & {
  actor: SessionActor;
  storage: SessionActorStorage;
};

const managerBindings = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionManagerMemoryBindings"),
  () => new WeakMap<object, SessionManagerMemoryBinding>(),
);
const activeMemoryBindings = new AsyncLocalStorage<
  ReadonlyMap<object, ActiveSessionManagerMemoryBinding>
>();

/** Accepted nested writes borrow the phase handle while the outer operation drains. */
export function withSessionManagerMemoryBinding<T>(
  manager: object,
  binding: ActiveSessionManagerMemoryBinding,
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

function selectedActor(target: SessionTranscriptRuntimeTarget) {
  const injected = getSessionActorStorageBinding(target);
  if (injected) {
    return injected;
  }
  const owned = getOwnedSessionTranscriptActor(target);
  if (owned?.actor.target.database.kind !== "memory" || !owned.actor.storage) {
    return undefined;
  }
  return {
    actor: owned.actor,
    agentId: owned.database.agentId!,
    path: owned.database.path!,
    authority: { assertCurrent: captureOwnedTranscriptWriteAssertion(target), authorize() {} },
  };
}

function retainAcquisition(
  binding: Omit<SessionManagerMemoryBinding, "acquire">,
  selected: { actor: SessionActor },
): SessionManagerMemoryBinding {
  const acquire = selected.actor.storage!.acquire;
  const assertCurrent = binding.authority.assertCurrent;
  return {
    ...binding,
    // Storage retains the owner factory, not a live manager handle. A new caller lifetime
    // lets this manager survive release of the caller that originally opened it.
    acquire: () =>
      acquire(binding.target.sessionKey, { assertCurrent, assertReadable: assertCurrent }),
  };
}

export function captureSessionManagerIncognitoBinding(
  target: SessionTranscriptRuntimeTarget | undefined,
  manager?: object,
  retarget = false,
): SessionManagerMemoryBinding | undefined {
  if (!target) {
    return undefined;
  }
  const retained = manager
    ? (activeMemoryBindings.getStore()?.get(manager) ?? managerBindings.get(manager))
    : undefined;
  if (retained && !retarget) {
    if (!sameSessionTranscriptTargetBinding(retained.target, target)) {
      throw new Error("Session manager target differs from its selected memory actor");
    }
    return retained;
  }
  const selected = selectedActor(target);
  const authority = selected?.authority ?? {
    assertCurrent: captureOwnedTranscriptWriteAssertion(target),
    authorize() {},
  };
  if (selected) {
    return retainAcquisition(
      {
        kind: "memory",
        authority,
        target,
        database: { agentId: selected.agentId, path: selected.path, env: target.env },
      },
      selected,
    );
  }
  const captured = captureSessionActorStorageOwner(target, authority);
  if (!captured) {
    return undefined;
  }
  const { agentId, path } = captured;
  let owner = captured.owner;
  const assertCurrent = authority.assertCurrent;
  const lifetime = { assertCurrent, assertReadable: assertCurrent };
  return {
    kind: "memory",
    authority,
    target,
    database: { agentId, path, env: target.env },
    async acquire(create) {
      owner ??= memorySessionActorOwners.read({ agentId, path });
      if (owner) {
        return create
          ? owner.acquire({ database: owner.identity, sessionKey: target.sessionKey }, lifetime)
          : owner.acquireExisting(target.sessionKey, lifetime);
      }
      if (!create) {
        return undefined;
      }
      const acquired = await acquireSessionActorStorage(target, {
        lifetime,
        authority,
        create: true,
      });
      return acquired?.actor;
    },
  };
}

/** Managers retain owner acquisition, never an unreleased actor handle. */
export function installSessionManagerIncognitoBinding(
  manager: object,
  binding: SessionManagerMemoryBinding | undefined,
): void {
  if (binding) {
    const { kind, authority, database, target, acquire } = binding;
    managerBindings.set(manager, { kind, authority, database, target, acquire });
  } else {
    managerBindings.delete(manager);
  }
}

export async function withSessionManagerMemoryActor<T>(
  binding: SessionManagerMemoryBinding,
  create: boolean,
  operation: (selected: ActiveSessionManagerMemoryBinding | undefined) => Promise<T>,
): Promise<T> {
  const borrowed = selectedActor(binding.target);
  const actor = borrowed?.actor ?? (await binding.acquire(create));
  if (!actor) {
    return operation(undefined);
  }
  const selected = {
    ...retainAcquisition(binding, { actor }),
    actor,
    storage: actor.storage!,
  };
  try {
    return await operation(selected);
  } finally {
    if (!borrowed) {
      await actor.release();
    }
  }
}

/** Refuse synchronous incognito persistence before local mutation or SQLite access. */
export function prepareSessionManagerSync(
  method: string,
  target: SessionTranscriptRuntimeTarget | undefined,
  manager?: object,
  replacement = `${method}Async`,
): void {
  const qualified = `SessionManager.${method}`;
  if (
    (manager && managerBindings.has(manager)) ||
    captureSessionManagerIncognitoBinding(target, manager)
  ) {
    throw new IncognitoSessionSyncAccessError(qualified, replacement);
  }
  warnSessionPersistenceDeprecation(qualified, replacement);
}
