import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { prepareSessionGenerationFacts } from "../../../config/sessions/session-delivery-generation.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { logVerbose } from "../../../globals.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import type { AgentRunSessionTarget } from "../../run-session-target.types.js";

export type SubagentKillSession = {
  storePath: string;
  entry?: SessionEntry;
  assertCurrent: () => void;
  release: () => void;
};

/** Retain the original session generation before native cancellation can yield. */
export async function prepareSubagentKillSession(
  cfg: OpenClawConfig,
  sessionKey: string,
  assertOwner: () => void,
  expected?: AgentRunSessionTarget,
): Promise<SubagentKillSession> {
  const agentId = resolveSessionAgentId({ config: cfg, sessionKey });
  const selected = expected?.sessionKey === sessionKey ? { ...expected } : undefined;
  const storePath =
    selected?.storePath ?? resolveSessionStorePathCore(cfg.session?.store, { agentId });
  let releaseLifetime: (() => void) | undefined;
  try {
    return await withSessionEntryReadOnlyInWorker(
      { storePath, sessionKey, agentId },
      assertOwner,
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        const entry = read.value;
        if (
          selected?.sessionId &&
          (entry?.sessionId !== selected.sessionId ||
            (selected.expectedLifecycleRevision !== undefined &&
              entry?.lifecycleRevision !== selected.expectedLifecycleRevision))
        ) {
          throw new Error("Subagent session changed during cancellation preparation");
        }
        const lifetime = await prepareSessionGenerationFacts({
          storePath: isIncognitoSessionKey(sessionKey)
            ? resolveIncognitoOpenClawAgentSqlitePath({ agentId })
            : storePath,
          sessionKey,
          agentId,
          sessionId: entry?.sessionId ?? null,
          lifecycleRevision: entry?.lifecycleRevision ?? null,
        });
        // The reader can reject after consumption; custody transfers only when it returns.
        releaseLifetime = lifetime.release;
        owner.assertCurrent();
        lifetime.assertCurrent();
        return {
          storePath,
          entry,
          release: lifetime.release,
          assertCurrent() {
            assertOwner();
            lifetime.assertCurrent();
          },
        };
      },
    );
  } catch (error) {
    releaseLifetime?.();
    throw error;
  }
}

export async function persistSubagentAbortedLastRun(params: {
  childSessionKey: string;
  storePath: string;
  hasSessionEntry: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  abortedLastRun: boolean;
  isCurrent?: (current: SessionEntry) => boolean;
  assertCommitAllowed?: () => void;
  strict?: boolean;
}): Promise<boolean> {
  if (!params.hasSessionEntry) {
    return true;
  }
  try {
    let selected: SessionEntry | undefined;
    await applySessionEntryExactReplacements({
      storePath: params.storePath,
      sessionKeys: [params.childSessionKey],
      activeSessionKey: params.childSessionKey,
      requireWriteSuccess: true,
      skipMaintenance: true,
      assertCommitAllowed: () => {
        params.assertCommitAllowed?.();
        if (selected && params.isCurrent?.(selected) === false) {
          throw new Error("Subagent abort-marker owner changed before commit.");
        }
      },
      update(entries) {
        selected = entries.find(({ sessionKey }) => sessionKey === params.childSessionKey)?.entry;
        const current = selected;
        const changed =
          current &&
          current.sessionId === params.expectedSessionId &&
          current.lifecycleRevision === params.expectedLifecycleRevision &&
          params.isCurrent?.(current) !== false;
        return {
          result: undefined,
          replacements: changed
            ? [
                {
                  sessionKey: params.childSessionKey,
                  entry: {
                    ...current,
                    abortedLastRun: params.abortedLastRun,
                    updatedAt: Date.now(),
                  },
                },
              ]
            : [],
        };
      },
    });
    return true;
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    if (params.strict) {
      throw error;
    }
    logVerbose(
      `subagents control kill: failed to persist abortedLastRun=${params.abortedLastRun} for ${params.childSessionKey}: ${formatErrorMessage(error)}`,
    );
    return false;
  }
}
