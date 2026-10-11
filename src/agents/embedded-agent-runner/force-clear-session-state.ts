import { getRuntimeConfig } from "../../config/io.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  acquireSessionActorStorage,
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
  runWithSessionActorStorage,
  type CapturedSessionActorStorageOwner,
} from "../../config/sessions/session-actor-storage-binding.js";
import { diagnosticLogger as diag } from "../../logging/diagnostic.js";
import { resolveSessionAgentId } from "../agent-scope.js";

type ForceClearSessionSnapshot = {
  memory?: CapturedSessionActorStorageOwner;
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
    const source = captureSessionActorStorageOwner(
      {
        agentId,
        sessionKey,
        storePath: configuredStorePath,
      },
      { assertCurrent() {}, authorize() {} },
    );
    const storePath = source?.path ?? configuredStorePath;
    // Cancellation must not queue behind the run whose settlement it is waiting for.
    const entry = source
      ? readCapturedSessionActorEntry(source, sessionKey)
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
      memory: source,
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
        },
      );
    if (params.memory) {
      const source = params.memory;
      const lifetime = {
        assertCurrent: () => source.authority.assertCurrent(),
        assertReadable: () => source.authority.assertCurrent(),
      };
      const actor = source.owner
        ? await source.owner.acquireExisting(params.sessionKey, lifetime)
        : source.binding
          ? (
              await acquireSessionActorStorage(
                { ...params, sessionActor: source.binding },
                {
                  lifetime,
                  authority: source.authority,
                },
              )
            )?.actor
          : undefined;
      if (!actor) {
        return;
      }
      try {
        await runWithSessionActorStorage({ ...source, actor }, persist);
      } finally {
        await actor.release();
      }
    } else {
      await persist();
    }
  } catch (err) {
    // Registry ownership is already gone; preserve the completed recovery result.
    diag.warn(
      `persist force-cleared terminal state failed: sessionKey=${params.sessionKey} error=${String(err)}`,
    );
  }
}
