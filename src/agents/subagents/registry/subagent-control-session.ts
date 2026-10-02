import { cloneEnvWithPlatformSemantics } from "../../../config/config-env-vars.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { withSessionEntryWorker } from "../../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import { prepareSessionGenerationFacts } from "../../../config/sessions/session-delivery-generation.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { logVerbose } from "../../../globals.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
  type OpenClawAgentDatabaseExecution,
} from "../../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import type { AgentRunSessionTarget } from "../../run-session-target.types.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";

export type SubagentKillSession = {
  agentId: string;
  storePath: string;
  entry?: SessionEntry;
  assertCurrent: () => void;
  withPublication: <T>(run: () => Promise<T>) => Promise<T>;
  release: () => void | Promise<void>;
};

/** Retain the original session generation before native cancellation can yield. */
export async function prepareSubagentKillSession(
  cfg: OpenClawConfig,
  sessionKey: string,
  assertOwner: () => void,
  expected?: AgentRunSessionTarget,
  childAgentId?: string,
): Promise<SubagentKillSession> {
  const childOwner = resolveSubagentChildSessionOwner(
    { childSessionKey: sessionKey, childAgentId },
    cfg,
  );
  const { agentId } = childOwner;
  const env = cloneEnvWithPlatformSemantics(process.env);
  const selected = expected?.sessionKey === sessionKey ? { ...expected } : undefined;
  const storePath = selected?.storePath ?? childOwner.storePath;
  let releaseLifetime: (() => void) | undefined;
  let execution: OpenClawAgentDatabaseExecution | undefined;
  const release = async () => {
    releaseLifetime?.();
    await execution?.release();
  };
  try {
    return await withSessionEntryReadOnlyInWorker(
      { storePath, sessionKey, agentId, env },
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
        const generationStorePath = isIncognitoSessionKey(sessionKey)
          ? resolveIncognitoOpenClawAgentSqlitePath({ agentId, env })
          : storePath;
        const database = {
          agentId: owner.scope?.databaseAgentId ?? agentId,
          path: owner.scope?.storePath ?? generationStorePath,
          env: owner.scope?.env ?? env,
        };
        if (entry && owner.kind === "file" && supportsOpenClawAgentDatabaseExecution(database)) {
          const identity = readDatabasePathIdentitySync(database.path);
          if (!identity.key.startsWith("file:")) {
            throw new Error(
              "Subagent session database disappeared before cancellation preparation",
            );
          }
          execution = captureOpenClawAgentDatabaseExecution(database, {
            expectedIdentity: {
              kind: "file",
              physicalIdentity: identity.key.slice("file:".length),
              nativeLocation: identity.canonicalPath,
              birthtime: identity.birthtime,
            },
          });
          // Registration publishes topology. Finish it before retaining generation facts,
          // then keep the native owner borrowed across drain and marker publication.
          await withSessionEntryWorker(
            database,
            undefined,
            () => {
              assertOwner();
              owner.assertCurrent();
            },
            async (writer, source) => {
              await owner.refreshBeforeDispatch?.(() => writer.assertCurrent());
              await writer.runExisting(
                { ...source, onRegistryChange: owner.onRegistryChange },
                async () => undefined,
              );
            },
            undefined,
            execution,
          );
          await owner.revalidateTarget?.();
        }
        const nativeGeneration = execution?.captureGenerationClaim();
        const lifetime = await prepareSessionGenerationFacts({
          storePath: generationStorePath,
          sessionKey,
          agentId,
          sessionId: entry?.sessionId ?? null,
          lifecycleRevision: entry?.lifecycleRevision ?? null,
        });
        // The reader can reject after consumption; custody transfers only when it returns.
        releaseLifetime = lifetime.release;
        owner.assertCurrent();
        const assertCurrent = () => {
          assertOwner();
          nativeGeneration?.assertCurrent();
          lifetime.assertCurrent();
        };
        assertCurrent();
        return {
          agentId,
          storePath,
          entry,
          release,
          assertCurrent,
          withPublication: (run) =>
            // The consumer checks its retained authority after joining the writer FIFO.
            runOpenClawAgentWriteAdmission(database, run),
        };
      },
    );
  } catch (error) {
    await release();
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
    logVerbose(
      `subagents control kill: failed to persist abortedLastRun=${params.abortedLastRun} for ${params.childSessionKey}: ${formatErrorMessage(error)}`,
    );
    return false;
  }
}
