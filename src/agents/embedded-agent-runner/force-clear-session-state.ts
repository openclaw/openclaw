import { getRuntimeConfig } from "../../config/io.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionBinding,
  type IncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import { diagnosticLogger as diag } from "../../logging/diagnostic.js";
import { resolveSessionAgentId } from "../agent-scope.js";

type ForceClearSessionSnapshot = {
  incognito?: IncognitoSessionBinding;
  assertCurrent?: () => void;
  agentId: string;
  lifecycleRunId?: string;
  startedAt?: number;
  storePath: string;
  updatedAt: number;
};

export function tryLoadForceClearSessionSnapshot(
  sessionKey: string,
  preparedAgentId?: string,
  runId?: string,
): ForceClearSessionSnapshot | undefined {
  try {
    const cfg = getRuntimeConfig();
    const agentId = resolveSessionAgentId({ config: cfg, sessionKey, agentId: preparedAgentId });
    const configuredStorePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const source = captureIncognitoSessionSource({
      agentId,
      sessionKey,
      storePath: configuredStorePath,
    });
    if (source && "kind" in source) {
      return undefined;
    }
    const storePath = source?.actor.path ?? configuredStorePath;
    const claim = source?.actor.sessions.captureCurrent(sessionKey);
    // Cancellation must not queue behind the run whose settlement it is waiting for.
    const entry = source
      ? source.actor.sessions.readSteering(sessionKey)
      : loadSessionEntry({ agentId, sessionKey, storePath });
    if (
      !entry ||
      entry.status !== undefined ||
      (runId !== undefined && entry.lifecycleRunId !== runId)
    ) {
      return undefined;
    }
    return {
      agentId,
      incognito: source ? { actor: source.actor } : undefined,
      assertCurrent: claim?.assertCurrent,
      lifecycleRunId: entry.lifecycleRunId,
      ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
      storePath,
      updatedAt: entry.updatedAt,
    };
  } catch (err) {
    diag.warn(
      `load force-clear session snapshot failed: sessionKey=${sessionKey} error=${String(err)}`,
    );
    return undefined;
  }
}

/** Persists terminal state when a forced registry clear cannot emit normal lifecycle. */
export async function persistForceClearedEmbeddedRunTerminalState(
  params: ForceClearSessionSnapshot & { sessionId: string; sessionKey: string },
  hasActiveRun: (sessionId: string, sessionKey: string) => boolean,
): Promise<void> {
  try {
    const persist = () =>
      patchSessionEntryCore(
        {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        },
        (entry) => {
          params.assertCurrent?.();
          // A replacement can reuse the session id; bind this patch to both owners' exact snapshot.
          if (
            hasActiveRun(params.sessionId, params.sessionKey) ||
            entry.sessionId !== params.sessionId ||
            entry.status !== undefined ||
            entry.lifecycleRunId !== params.lifecycleRunId ||
            entry.updatedAt !== params.updatedAt ||
            entry.startedAt !== params.startedAt
          ) {
            return null;
          }
          const endedAt = Date.now();
          return {
            status: "killed",
            abortedLastRun: true,
            lifecycleRunId: undefined,
            endedAt,
            updatedAt: endedAt,
          };
        },
        {
          skipMaintenance: true,
          takeCacheOwnership: true,
          requireWriteSuccess: false,
          ...(params.incognito
            ? {
                assertCommitAllowed() {
                  params.assertCurrent?.();
                  if (hasActiveRun(params.sessionId, params.sessionKey)) {
                    throw new Error("Force-clear terminal persistence lost its run ownership");
                  }
                },
              }
            : {}),
        },
      );
    params.assertCurrent?.();
    await (params.incognito ? withIncognitoSessionBinding(params.incognito, persist) : persist());
  } catch (err) {
    // Registry ownership is already gone; preserve the completed recovery result.
    diag.warn(
      `persist force-cleared terminal state failed: sessionKey=${params.sessionKey} error=${String(err)}`,
    );
  }
}
