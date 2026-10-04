import { AsyncLocalStorage } from "node:async_hooks";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { IncognitoSessionActor } from "../../config/sessions/session-incognito-actor.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";

const actorScope = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionManagerIncognitoActor"),
  () =>
    new AsyncLocalStorage<{
      actor: IncognitoSessionActor;
      admissionSignal?: AbortSignal;
    }>(),
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

export function captureSessionManagerIncognitoActor(
  target: SessionTranscriptRuntimeTarget | undefined,
) {
  const actor = actorScope.getStore()?.actor;
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
  return actor;
}

export function assertSessionManagerIncognitoAdmission(): void {
  actorScope.getStore()?.admissionSignal?.throwIfAborted();
}
