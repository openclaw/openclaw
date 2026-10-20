import { AsyncLocalStorage } from "node:async_hooks";
import { sleepWithAbort } from "@openclaw/retry";
import { runOutsideOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import { createAbortError, racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.context.js";
import {
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
} from "../../sessions/session-controller.identity.js";
import {
  sessionTargetOwnersMatch,
  type SessionTarget,
} from "../../sessions/session-controller.target.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { withoutGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";

type MaintenanceOwner = {
  controller: AbortController;
  done: Promise<void>;
  writesDone: Promise<void>;
  writesReleased: boolean;
  predecessors: readonly MaintenanceOwner[];
  preemptible: boolean;
  running: boolean;
  sleeping: boolean;
  target?: SessionTarget;
};
type SessionMaintenance = {
  owners: Set<MaintenanceOwner>;
  foreground: number;
  wake: Set<() => void>;
};
const state = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionMaintenance"),
  () => ({
    sessions: new Map<string, SessionMaintenance>(),
    current: new AsyncLocalStorage<ReadonlySet<MaintenanceOwner>>(),
  }),
  (current) => {
    for (const session of current.sessions.values()) {
      for (const owner of session.owners) {
        owner.controller.abort(createAbortError("Session maintenance stopped with its host"));
      }
    }
  },
);

function sessionState(key: string): SessionMaintenance {
  let session = state.sessions.get(key);
  if (!session) {
    session = { owners: new Set(), foreground: 0, wake: new Set() };
    state.sessions.set(key, session);
  }
  return session;
}

function releaseSessionState(key: string, session: SessionMaintenance): void {
  if (!session.foreground && !session.owners.size && state.sessions.get(key) === session) {
    state.sessions.delete(key);
  }
}

function independentOwners(
  session: SessionMaintenance | undefined,
  current: ReadonlySet<MaintenanceOwner> | undefined,
  includeSleeping = false,
): MaintenanceOwner[] {
  const blocked = new Set(current);
  // Owners are registered in dependency order. Work waiting on an active ancestor
  // cannot precede its child; released writes no longer propagate that dependency.
  return [...(session?.owners ?? [])].filter((owner) => {
    // An idle timer owns cancellation, not a transcript writer or a read barrier.
    if (owner.sleeping && !includeSleeping) {
      return false;
    }
    if (
      blocked.has(owner) ||
      owner.predecessors.some(
        (predecessor) => !predecessor.writesReleased && blocked.has(predecessor),
      )
    ) {
      blocked.add(owner);
      return false;
    }
    return true;
  });
}

registerAgentEventLifecycleRotationHandler("session-maintenance", () => {
  for (const session of state.sessions.values()) {
    for (const owner of session.owners) {
      owner.controller.abort(createAbortError("Session maintenance retired with its lifecycle"));
    }
  }
});

function waitsForCurrentTurn(owner: MaintenanceOwner): boolean {
  if (owner.running || !owner.target) {
    return false;
  }
  const operation = getCurrentSessionControllerOwner();
  if (!operation || !isCurrentSessionControllerOperation(operation)) {
    return false;
  }
  const entry = getSessionControllerEntryForOperation(operation);
  return Boolean(
    entry.target &&
    entry.aliases.has(owner.target.sessionKey) &&
    sessionTargetOwnersMatch(entry.target, owner.target),
  );
}

/** Tracks a producer's real completion; cancellation never releases a writer early. */
export function createSessionMaintenanceOwner(params: {
  sessionKey: string;
  preemptible?: boolean;
  target?: SessionTarget;
  abortSignal?: AbortSignal;
  /** Optional idle work remains cancellable without holding the session read barrier. */
  notBefore?: number;
}) {
  const key = params.sessionKey.trim();
  const session = sessionState(key);
  const generation = getAgentEventLifecycleGeneration();
  const ancestors = state.current.getStore() ?? new Set<MaintenanceOwner>();
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    getGatewayRestartDrainSignal(),
    ...(params.abortSignal ? [params.abortSignal] : []),
  ]);
  const { promise: done, resolve: finish } = createDeferredCore();
  const { promise: writesDone, resolve: finishWrites } = createDeferredCore();
  const releaseWrites = () => {
    owner.writesReleased = true;
    owner.predecessors = [];
    finishWrites();
  };
  const owner: MaintenanceOwner = {
    controller,
    done,
    writesDone,
    writesReleased: false,
    predecessors: independentOwners(session, ancestors),
    preemptible: params.preemptible === true,
    running: params.preemptible !== true,
    sleeping: params.notBefore !== undefined && params.notBefore > Date.now(),
    target: params.target,
  };
  session.owners.add(owner);
  const assertCurrent = () => {
    signal.throwIfAborted();
    assertAgentRunLifecycleGenerationCurrent(generation);
    if (owner.writesReleased || !session.owners.has(owner)) {
      throw createAbortError("Session maintenance owner is closed");
    }
  };
  return {
    signal,
    done,
    assertCurrent,
    releaseWrites,
    run: async <T>(
      work:
        | (() => Promise<T>)
        | { admit: (run: (work: () => Promise<T>) => Promise<T>) => Promise<T> },
    ): Promise<T> => {
      if (owner.sleeping) {
        await sleepWithAbort(Math.max(0, (params.notBefore ?? 0) - Date.now()), signal, {
          ref: false,
        });
        owner.sleeping = false;
      }
      // Waiting on successors would make nested model reads mutually await sibling work.
      await Promise.all(owner.predecessors.map((predecessor) => predecessor.writesDone));
      if (owner.preemptible) {
        while (session.foreground > 0) {
          const { promise: available, resolve: wake } = createDeferredCore();
          session.wake.add(wake);
          try {
            await racePromiseWithAbortSignal(available, signal);
          } finally {
            session.wake.delete(wake);
          }
        }
        assertCurrent();
      }
      const run = (execute: () => Promise<T>) => {
        if (owner.preemptible) {
          assertCurrent();
          // Queued controller admission is not a writer that its current turn must drain.
          owner.running = true;
        }
        // Maintenance owns this session's work, never its launching turn's tool grants.
        return withoutGatewayToolCallerIdentity(() =>
          runOutsideOperatorToolGatewayAuthority(() =>
            // Nested model reads must not wait on their own maintenance parent.
            state.current.run(new Set([...ancestors, owner]), execute),
          ),
        );
      };
      return typeof work === "function" ? run(work) : work.admit(run);
    },
    track: <T>(work: Promise<T>): Promise<T> =>
      work.finally(() => {
        releaseWrites();
        session.owners.delete(owner);
        finish();
        releaseSessionState(key, session);
      }),
  };
}

/** Reserve foreground priority before queueing so optional work cannot seize its lane. */
export async function beginForegroundSessionMaintenance(sessionKey?: string): Promise<() => void> {
  const key = sessionKey?.trim();
  if (!key) {
    return () => {};
  }
  const session = sessionState(key);
  session.foreground += 1;
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    session.foreground -= 1;
    if (!session.foreground) {
      for (const wake of session.wake) {
        wake();
      }
    }
    releaseSessionState(key, session);
  };
  const current = state.current.getStore();
  const existing = independentOwners(session, current, true);
  const optional = existing.filter((owner) => owner.preemptible);
  for (const owner of optional) {
    owner.controller.abort(createAbortError("Session maintenance yielded to a foreground turn"));
  }
  await Promise.all(existing.map((owner) => owner.done));
  return release;
}

/** Read checkpoint shared by foreground and nested maintenance inference. */
export async function waitForSessionMaintenance(sessionKey?: string): Promise<void> {
  const session = sessionKey ? state.sessions.get(sessionKey.trim()) : undefined;
  const current = state.current.getStore();
  const blocked = new Set(current);
  for (const owner of session?.owners ?? []) {
    if (waitsForCurrentTurn(owner)) {
      blocked.add(owner);
    }
  }
  await Promise.all(
    independentOwners(session, blocked)
      .filter((owner) => owner.running || session?.foreground === 0)
      .map((owner) => (current?.size ? owner.writesDone : owner.done)),
  );
}
