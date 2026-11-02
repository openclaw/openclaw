import { cloneEnvWithPlatformSemantics } from "../../../config/config-env-vars.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import {
  isSessionDeliveryGenerationRevokedError,
  prepareSessionGenerationFacts,
} from "../../../config/sessions/session-delivery-generation.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { logVerbose } from "../../../globals.js";
import { throwCollectedErrors } from "../../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import type { AgentRunSessionTarget } from "../../run-session-target.types.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentKillSession = {
  agentId: string;
  storePath: string;
  entry?: SessionEntry;
  assertCurrent: () => void;
  prepareRead: () => Promise<void> | undefined;
  withPublication: <T>(run: () => Promise<T>) => Promise<T>;
  release: () => void | Promise<void>;
};

export function prepareSubagentKillSessionReads(
  preparations: Array<SubagentKillSession["prepareRead"] | undefined>,
  assertCurrent: () => void,
): Promise<void> | undefined {
  const failures: unknown[] = [];
  const publications = preparations.flatMap((prepare) => {
    try {
      const publication = prepare?.();
      return publication ? [publication] : [];
    } catch (error) {
      if (!isSessionDeliveryGenerationRevokedError(error)) {
        failures.push(error);
      }
      return [];
    }
  });
  if (publications.length === 0) {
    throwCollectedErrors(failures, "Subagent publication readiness failed");
    return undefined;
  }
  return Promise.allSettled(publications).then((results) => {
    try {
      assertCurrent();
    } catch (error) {
      failures.push(error);
    }
    for (const result of results) {
      if (result.status === "rejected" && !isSessionDeliveryGenerationRevokedError(result.reason)) {
        failures.push(result.reason);
      }
    }
    throwCollectedErrors(failures, "Subagent publication readiness failed");
  });
}

/** Retain the original session generation before native cancellation can yield. */
export async function prepareSubagentKillSession(
  cfg: OpenClawConfig,
  sessionKey: string,
  assertOwner: () => void,
  expected?: AgentRunSessionTarget,
  childAgentId?: string,
  original?: SubagentRunRecord["childSessionIdentity"],
  requesterOwnedRun?: SubagentRunRecord,
): Promise<SubagentKillSession> {
  const childOwner = resolveSubagentChildSessionOwner(
    { childSessionKey: sessionKey, childAgentId },
    cfg,
  );
  const { agentId } = childOwner;
  const env = cloneEnvWithPlatformSemantics(process.env);
  const selected = expected?.sessionKey === sessionKey ? { ...expected } : undefined;
  const storePath = selected?.storePath ?? childOwner.storePath;
  const taskAuthority = requesterOwnedRun && resolveSubagentChildAuthority(requesterOwnedRun);
  const prepareLegacySession = (
    currentSession?: Pick<SessionEntry, "sessionId">,
  ): SubagentKillSession | undefined => {
    if (
      requesterOwnedRun?.childSessionKey !== sessionKey ||
      taskAuthority?.status !== "legacy-unverified" ||
      taskAuthority.childAgentId !== agentId
    ) {
      return undefined;
    }
    if (resolveSubagentChildAuthority(requesterOwnedRun, currentSession).status === "mismatch") {
      throw new Error(
        "Subagent original session incarnation is unresolved or changed; no child work was changed.",
      );
    }
    assertOwner();
    return {
      agentId,
      storePath,
      assertCurrent: assertOwner,
      prepareRead: () => undefined,
      withPublication: (run) => run(),
      release: () => {},
    };
  };
  const legacySession = !requesterOwnedRun?.childSessionIdentity?.sessionId
    ? prepareLegacySession()
    : selected?.sessionId
      ? prepareLegacySession({ sessionId: selected.sessionId })
      : undefined;
  if (legacySession) {
    return legacySession;
  }
  let releaseLifetime: (() => void) | undefined;
  const release = () => {
    releaseLifetime?.();
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
        // An absent child row is missing evidence, not a conflicting incarnation.
        const readLegacySession = prepareLegacySession(entry);
        if (readLegacySession) {
          return readLegacySession;
        }
        if (
          resolveSubagentChildAuthority(
            { childSessionKey: sessionKey, childAgentId: agentId, childSessionIdentity: original },
            entry,
          ).status !== "verified"
        ) {
          throw new Error(
            "Subagent original session incarnation is unresolved or changed; no child work was changed.",
          );
        }
        if (
          selected?.sessionId &&
          resolveSubagentChildAuthority(
            {
              childSessionKey: sessionKey,
              childAgentId: agentId,
              childSessionIdentity: {
                sessionId: selected.sessionId,
                lifecycleRevision: selected.expectedLifecycleRevision,
              },
            },
            entry ?? null,
          ).status !== "verified"
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
        const lifetime = await prepareSessionGenerationFacts({
          storePath: database.path,
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
          lifetime.assertCurrent();
        };
        const prepareRead = () => {
          assertOwner();
          return lifetime.prepareRead();
        };
        return {
          agentId,
          storePath,
          entry,
          release,
          assertCurrent,
          prepareRead,
          withPublication: (run) =>
            runOpenClawAgentWriteAdmission(database, async () => {
              try {
                for (let pending = prepareRead(); pending; pending = prepareRead()) {
                  await pending;
                }
              } catch (error) {
                if (!isSessionDeliveryGenerationRevokedError(error)) {
                  throw error;
                }
              }
              // The consumer publishes a truthful revoked-owner outcome under the FIFO.
              assertOwner();
              return run();
            }),
        };
      },
    );
  } catch (error) {
    release();
    throw error;
  }
}

export async function persistSubagentAbortedLastRun(params: {
  childSessionKey: string;
  session: Pick<SubagentKillSession, "storePath" | "entry">;
  abortedLastRun: boolean;
  isCurrent?: (current: SessionEntry) => boolean;
  assertCommitAllowed?: () => void;
}): Promise<boolean> {
  const { storePath, entry } = params.session;
  if (!entry) {
    return true;
  }
  const { sessionId, lifecycleRevision } = entry;
  try {
    let selected: SessionEntry | undefined;
    const assertCommitAllowed = () => {
      params.assertCommitAllowed?.();
      if (selected && params.isCurrent?.(selected) === false) {
        throw new Error("Subagent abort-marker owner changed before commit.");
      }
    };
    await applySessionEntryExactReplacements({
      storePath,
      sessionKeys: [params.childSessionKey],
      activeSessionKey: params.childSessionKey,
      requireWriteSuccess: true,
      skipMaintenance: true,
      assertCommitAllowed,
      update(entries) {
        selected = entries.find(({ sessionKey }) => sessionKey === params.childSessionKey)?.entry;
        const current = selected;
        const changed =
          current &&
          current.sessionId === sessionId &&
          current.lifecycleRevision === lifecycleRevision &&
          params.isCurrent?.(current) !== false;
        if (changed && current.abortedLastRun === params.abortedLastRun) {
          assertCommitAllowed();
          return { result: undefined };
        }
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
