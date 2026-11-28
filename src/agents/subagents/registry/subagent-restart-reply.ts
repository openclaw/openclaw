import { getRuntimeConfig } from "../../../config/config.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../../../config/sessions/session-entry-current-check.js";
import { isCurrentRecoveryWriter } from "../../../config/sessions/session-recovered-result.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { assertionSucceeds } from "../../../shared/assertion.js";
import { resolveModelAgentRuntimeMetadata } from "../../agent-runtime-metadata.js";
import { captureAgentHarnessLifecycleHooks } from "../../harness/registry-lifecycle.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  preserveRecoveredSubagentReply,
  readRecoveredSubagentReply,
} from "./subagent-restart-transcript.js";
import { getSubagentRunRuntimeKey, isSameSubagentRun } from "./subagent-run-generation.js";
import { isSubagentRunLive, isSubagentRunQueued } from "./subagent-run-liveness.js";

type Status = "pending" | "published" | undefined;
const reads = new WeakMap<object, { count: number; nextAt: number }>();
const NATIVE_READ_BACKOFF_MS = 5 * 60_000;
const warned = new WeakSet<object>();

/** A claim prevents cleanup across another restart. It cannot authorize a history read. */
async function claimReplyRecovery(
  entry: SubagentRunRecord,
  harness: string,
  assertCurrent: () => void,
): Promise<SubagentRunRecord> {
  const { runId } = entry;
  let installed: SubagentRunRecord | undefined;
  await mutateSubagentRuns(
    [runId],
    (rows) => {
      const selected = rows.get(runId);
      if (!selected || !isSameSubagentRun(selected, entry)) {
        throw new Error("Worker recovery lost its run");
      }
      const claimed = {
        ...selected,
        execution: { ...selected.execution, replyRecoveryHarness: harness },
      };
      return { value: undefined, postimages: new Map([[runId, claimed]]) };
    },
    {
      assertCurrent,
      onPublished: () => {
        installed = subagentRuns.get(runId);
      },
    },
  );
  if (
    !installed ||
    !isSameSubagentRun(installed, entry) ||
    installed.execution.replyRecoveryHarness !== harness
  ) {
    throw new Error("Worker recovery claim was not installed");
  }
  return installed;
}

export async function recoverInterruptedSubagentReply(
  observed: SubagentRunRecord,
  scope: NonNullable<SubagentCompletionRequest["recoveryCurrent"]>,
  complete: ReturnType<
    typeof createSubagentRegistryCompletionRuntime
  >["completeSubagentRunWithRecovery"],
): Promise<Status> {
  let entry = observed;
  const claimedBy = entry.execution.replyRecoveryHarness;
  const auth = resolveSubagentChildAuthority(entry);
  const { runId, childSessionKey: sessionKey } = entry;
  if (auth.status !== "verified" || isIncognitoSessionKey(sessionKey)) {
    return claimedBy ? "pending" : undefined;
  }
  const key = getSubagentRunRuntimeKey(entry);
  let published = false;
  const previous = reads.get(key);
  const defer = (): Status => {
    if (!warned.has(key)) {
      warned.add(key);
      subagentRegistryLog.warn(
        "Worker result still unresolved. Retaining the session. Check the original worker and restore its connection before retrying.",
        { runId },
      );
    }
    return "pending";
  };
  try {
    return await subagentRuns.runWithCompletionAuthority(
      entry,
      async (custody): Promise<Status> => {
        if (!custody) {
          return claimedBy ? defer() : undefined;
        }
        const config = getRuntimeConfig();
        const { agentId, storePath } = resolveSubagentChildSessionOwner(entry, config);
        const identity = { agentId, sessionKey, ...auth.sessionIdentity, runId };
        const session = await captureSessionEntryCurrentCheckAsyncInternal({
          agentId,
          storePath,
          sessionKey,
          fields: ["activeWriterRunId", "lifecycleRunId", "archivedAt", "abortedLastRun"],
        });
        let active = true;
        const assertOwner = () => {
          custody.assertCurrent();
          if (
            !active ||
            !scope.isHostCurrent() ||
            subagentRuns.get(runId) !== entry ||
            entry.killIntent ||
            entry.killReconciliation ||
            subagentRuns.isCompletionAuthorityRetired(entry) ||
            isSubagentRunLive(entry) ||
            isSubagentRunQueued(entry)
          ) {
            throw new Error("Interrupted worker recovery lost its owner");
          }
        };
        try {
          const { entry: row, entryCurrent } = session;
          const target = { ...identity, storePath, assertCurrent: assertOwner };
          if (
            !entryCurrent ||
            !isCurrentRecoveryWriter(target, row) ||
            resolveSubagentChildAuthority(entry, row).status !== "verified"
          ) {
            return claimedBy || previous || warned.has(key) ? defer() : undefined;
          }
          // A crash between the transcript and registry commits must not depend on a second native read.
          let reply = await readRecoveredSubagentReply(target);
          if (!reply) {
            // A rate limit cannot establish termination. A saved local final bypasses it.
            if (previous && Date.now() < previous.nextAt) {
              return "pending";
            }
            let accepted = false;
            const runtime = resolveModelAgentRuntimeMetadata({
              cfg: config,
              agentId,
              sessionKey,
              sessionEntry: row,
              provider: row.providerOverride ?? row.modelProvider,
              model: row.modelOverride ?? row.model,
            });
            const owners = captureAgentHarnessLifecycleHooks("withInterruptedSubagentReply").filter(
              (owner) => owner.registration.harness.id === runtime.id,
            );
            const [owner] = owners;
            if (!owner || owners.length !== 1 || (claimedBy && claimedBy !== runtime.id)) {
              return claimedBy || previous ? defer() : undefined;
            }
            let reading = true;
            const assertCurrent = () => {
              assertOwner();
              if (!reading || !owner.isCurrent()) {
                throw new Error("Interrupted worker harness changed");
              }
            };
            try {
              assertCurrent();
              const count = (previous?.count ?? 0) + 1;
              reads.set(key, {
                count,
                nextAt: count < 3 ? 0 : Date.now() + NATIVE_READ_BACKOFF_MS,
              });
              const result = await owner.prepare({
                ...identity,
                config,
                assertCurrent,
                claim: async () => {
                  assertCurrent();
                  if (!entry.execution.replyRecoveryHarness) {
                    await session.assertCurrent();
                    entry = await claimReplyRecovery(
                      entry,
                      owner.registration.harness.id,
                      assertCurrent,
                    );
                    assertCurrent();
                  }
                },
                accept: async (rawText, assertBindingCurrent, idempotencyKey) => {
                  const check = () => {
                    assertCurrent();
                    assertBindingCurrent();
                  };
                  check();
                  if (accepted || !entry.execution.replyRecoveryHarness) {
                    throw new Error("Repeated or unclaimed worker recovery");
                  }
                  accepted = true;
                  await session.assertCurrent();
                  reply = await preserveRecoveredSubagentReply({
                    ...target,
                    rawText,
                    idempotencyKey,
                    assertCurrent: check,
                  });
                },
              });
              if (!reply) {
                if (
                  !accepted &&
                  (result === "interrupted" ||
                    (!entry.execution.replyRecoveryHarness && result === undefined))
                ) {
                  await session.assertCurrent();
                  assertCurrent();
                  reads.delete(key);
                  return undefined;
                }
                return result === "pending" && count < 3 ? "pending" : defer();
              }
            } finally {
              reading = false;
            }
          }
          // From this point the evidence is a committed local final. Native availability is immaterial.
          assertOwner();
          const isHostCurrent = () =>
            published ? scope.isHostCurrent() : assertionSucceeds(assertOwner);
          await complete(
            {
              runId,
              expectedEntry: entry,
              endedAt: Date.now(),
              outcome: { status: "ok" },
              terminalReply: reply,
              reason: SUBAGENT_ENDED_REASON_COMPLETE,
              accountId: entry.requesterOrigin?.accountId,
              triggerCleanup: true,
              sendFarewell: true,
              recoveredReplyCheck: entryCurrent,
              recoveryCurrent: {
                isHostCurrent,
                prepare: async () =>
                  (await scope.prepare()) &&
                  (published || (await session.isCurrent())) &&
                  isHostCurrent(),
                onPublished: (postimage) => {
                  published =
                    isSameSubagentRun(postimage, entry) &&
                    postimage.execution.status === "terminal" &&
                    postimage.execution.outcome?.status === "ok";
                },
              },
            },
            "sweeper-recovered-reply",
          );
          return published ? "published" : defer();
        } finally {
          active = false;
          session.release();
        }
      },
    );
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    return published ? "published" : defer();
  }
}
