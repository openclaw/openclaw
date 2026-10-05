import { getChannelPlugin } from "../../../channels/plugins/index.js";
import type { ProgressContinuationCapability } from "../../../channels/progress-continuation.js";
import { createChannelProgressDraftCompositor } from "../../../channels/progress-draft-compositor.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { captureSessionEntryCurrentRead } from "../../../config/sessions/session-entry-current-runtime.js";
import type { CapturedSessionEntryCurrentRead } from "../../../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { onAgentEventForRun, type AgentEventPayload } from "../../../infra/agent-events.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import { resolveMessageActionOutcome } from "../../../infra/outbound/message-action-contracts.js";
import { runMessageAction } from "../../../infra/outbound/message-action-runner.js";
import { normalizeTargetForProvider } from "../../../infra/outbound/target-normalization.js";
import { channelRouteTargetsMatchExact } from "../../../plugin-sdk/channel-route.js";
import {
  getSharedGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  getGatewayRestartDrainSignal,
  runWithGatewayDetachedWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { withRequesterCronAuthority } from "../requester-cron-authority.js";
import { captureSubagentProgressChannelPolicy } from "./subagent-progress-channel-policy.js";
import { withActiveSubagentProgressContinuation } from "./subagent-progress-context.js";
import {
  projectSubagentProgressActivity,
  projectSubagentProgressState,
} from "./subagent-progress-presentation.js";
import { getSubagentRunsForChildSession, subagentRuns } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";

type Presentation = {
  promote(entries: readonly SubagentRunRecord[], generation?: number): void;
  resume(
    runId: string,
    isCurrent: () => boolean,
    run: () => Promise<SubagentAnnounceDeliveryResult>,
  ): Promise<SubagentAnnounceDeliveryResult>;
};
// Live presentation capabilities of registry owners, not tasks, completion credit,
// or recovery state. A replacement Gateway cannot restore transport custody.
const presentations = new WeakMap<object, Presentation>();
const MAX_PRESENTATION_CHILDREN = 32;
const PROGRESS_COALESCE_MS = 1_000;

type ProgressRequester = {
  requesterSessionKey: string;
  requesterAgentId: string;
  requesterSessionId: string;
  requesterTurnRunId: string;
  acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
  assertCurrent(): void;
};

/** Offer the existing card only to this accepted child cohort, never a fresh send. */
export function createSubagentProgressContinuation(
  params: ProgressRequester,
): ProgressContinuationCapability {
  let closed = false;
  let used = false;
  return {
    close: () => {
      closed = true;
    },
    adopt: async (receipt) => {
      if (closed || used) {
        return false;
      }
      used = true;
      let cleanupSource: Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>;
      let sourceTransferred = false;
      try {
        params.assertCurrent();
        const accepted = params.acceptedSessionSpawns.filter(
          (spawn) => spawn.expectsCompletionMessage === true,
        );
        if (
          !accepted.length ||
          accepted.length > MAX_PRESENTATION_CHILDREN ||
          !receipt.messageId.trim() ||
          !receipt.text.trim()
        ) {
          return false;
        }
        const rows = accepted.map((spawn) => {
          const latest = [...getSubagentRunsForChildSession(spawn.childSessionKey)].toSorted(
            (a, b) => compareSubagentRunGeneration(b, a),
          )[0];
          return latest && (latest.taskRunId ?? latest.runId) === spawn.runId ? latest : undefined;
        });
        if (rows.some((row) => !row)) {
          return false;
        }
        let entries = rows.filter((row): row is SubagentRunRecord => row !== undefined);
        if (entries.some((entry) => presentations.has(getSubagentRunRuntimeKey(entry)))) {
          return false;
        }
        const first = entries[0]!;
        const origin = first.progressOrigin;
        const channel = origin?.channel;
        const to = origin?.to;
        const accountId = origin?.accountId ?? "default";
        const plugin = channel ? getChannelPlugin(channel) : undefined;
        const resolveGatewayContext = getSharedGatewayContextResolver(entries);
        if (
          !origin ||
          !channel ||
          !to ||
          !plugin ||
          !resolveGatewayContext?.() ||
          !plugin.actions?.writeAuthorityActions?.includes("edit")
        ) {
          return false;
        }
        const expectedRevision = first.completionRequesterLifecycleRevision;
        const lifecycle = getAgentRunLifecycleGeneration();
        const stateContext = captureOpenClawStateWorkerContext();
        const abort = new AbortController();
        const signal = AbortSignal.any([abort.signal, getGatewayRestartDrainSignal()]);
        let generation: number | undefined;
        let resumedCurrent: (() => boolean) | undefined;
        let cleanupOnly = false;
        let editsDisabled = false;
        let yielding = false;
        const channelPolicy = captureSubagentProgressChannelPolicy({ channel, accountId, plugin });
        const entryConfig = channelPolicy.entry;
        const expectedRoute = {
          channel,
          accountId,
          to: normalizeTargetForProvider(channel, to, plugin),
          threadId: origin.threadId,
        };
        const assertOwner = () => {
          signal.throwIfAborted();
          cleanupSource?.assertCurrent();
          assertSubagentRegistryWriteSourceCurrent(stateContext);
          if (getAgentRunLifecycleGeneration() !== lifecycle || !resolveGatewayContext()) {
            throw new Error("Progress Gateway was replaced");
          }
          channelPolicy.assertCurrent();
          // Confirmed terminal delivery or native cancellation leaves only bounded card cleanup;
          // source custody stays live independently of retired completion rows.
          if (cleanupOnly) {
            return;
          }
          for (const original of entries) {
            const entry = subagentRuns.get(original.runId);
            if (
              !entry ||
              !isSameSubagentRunOwner(entry, original) ||
              entry.collect ||
              (!editsDisabled && (entry.killIntent || entry.killReconciliation)) ||
              entry.suppressCompletionDelivery ||
              entry.execution.suppressSessionEffects ||
              entry.requesterSessionKey !== params.requesterSessionKey ||
              entry.requesterAgentId !== params.requesterAgentId ||
              entry.completionRequesterSessionId !== params.requesterSessionId ||
              entry.completionRequesterLifecycleRevision !== expectedRevision
            ) {
              throw new Error("Progress child custody changed");
            }
            const captured = entry.progressOrigin;
            if (
              !captured ||
              !channelRouteTargetsMatchExact({
                left: {
                  channel: captured.channel,
                  accountId: captured.accountId ?? "default",
                  to: normalizeTargetForProvider(channel, captured.to ?? "", plugin),
                  threadId: captured.threadId,
                },
                right: expectedRoute,
              })
            ) {
              throw new Error("Progress source audience changed");
            }
            const wake = entry.requesterSettleWake;
            if (wake?.requesterYieldBatch === true && wake.rearmGeneration !== undefined) {
              generation ??= wake.rearmGeneration;
              if (
                wake.rearmGeneration !== generation ||
                wake.batchRunIds?.length !== entries.length ||
                !entries.every((member) => wake.batchRunIds?.includes(member.runId))
              ) {
                throw new Error("Progress yield cohort changed");
              }
            } else if (
              generation !== undefined ||
              entry.requesterTurnRunId !== params.requesterTurnRunId ||
              entry.requesterTurnYielded !== true
            ) {
              throw new Error("Progress requester no longer owns the handoff");
            }
          }
          if (resumedCurrent && !resumedCurrent()) {
            throw new Error("Progress successor was replaced");
          }
          subagentRuns.runWithCompletionBatchAuthority(entries, () => undefined);
        };
        assertOwner();
        if (
          !channelRouteTargetsMatchExact({
            left: {
              channel: receipt.channel,
              accountId: receipt.accountId ?? "default",
              to: normalizeTargetForProvider(channel, receipt.to, plugin),
              threadId: receipt.threadId,
            },
            right: expectedRoute,
          })
        ) {
          return false;
        }
        cleanupSource = await subagentRuns.runWithCompletionBatchAuthority(entries, () =>
          withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
            captureOperatorToolGatewayContinuationContext({
              sessionKey: params.requesterSessionKey,
              agentId: params.requesterAgentId,
            }),
          ),
        );
        if (!cleanupSource) {
          return false;
        }
        const source = cleanupSource;
        assertOwner();
        let currency: CapturedSessionEntryCurrentRead | undefined;
        await subagentRuns.runWithCompletionBatchAuthority(entries, () =>
          withSessionEntryReadOnlyInWorker(
            {
              sessionKey: params.requesterSessionKey,
              agentId: params.requesterAgentId,
              storePath: first.requesterStorePath,
            },
            assertOwner,
            async (read, owner) => {
              if (!read.ok) {
                throw read.error;
              }
              if (
                read.value?.sessionId !== params.requesterSessionId ||
                read.value.lifecycleRevision !== expectedRevision ||
                read.value.archivedAt
              ) {
                throw new Error("Progress requester incarnation changed");
              }
              currency = captureSessionEntryCurrentRead(
                {
                  sessionKey: params.requesterSessionKey,
                  agentId: params.requesterAgentId,
                  storePath: first.requesterStorePath,
                },
                owner,
              );
            },
          ),
        );
        params.assertCurrent();
        assertOwner();
        if (
          closed ||
          !currency ||
          entries.some(
            (entry) =>
              presentations.has(getSubagentRunRuntimeKey(entry)) ||
              subagentRuns.get(entry.runId)?.requesterSettleWake?.status === "dispatching",
          )
        ) {
          return false;
        }
        const read = currency;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let publication: Promise<void> | undefined;
        let editPending = false;
        let deletePending = false;
        const stops: Array<() => void> = [];
        let stopped = false;
        const stop = () => {
          if (stopped) {
            return;
          }
          stopped = true;
          abort.abort();
          source.release();
          compositor.cancel();
          clearTimeout(timer);
          for (const release of stops) {
            release();
          }
          for (const entry of entries) {
            if (presentations.get(getSubagentRunRuntimeKey(entry)) === presentation) {
              presentations.delete(getSubagentRunRuntimeKey(entry));
            }
          }
        };
        const compositor = createChannelProgressDraftCompositor({
          entry: entryConfig,
          mode: "progress",
          active: true,
          reasoningGate: false,
          preparedItems: true,
          seed: params.requesterTurnRunId,
          initialSnapshot: receipt.snapshot,
        });
        let lastText = receipt.text;
        const publish = (requestedAction: "edit" | "delete") => {
          if (stopped) {
            return;
          }
          if (requestedAction === "delete") {
            deletePending = true;
          } else if (!cleanupOnly && !editsDisabled) {
            editPending = true;
          }
          if (publication) {
            return;
          }
          const admittedAction = deletePending ? "delete" : "edit";
          let suspended = false;
          const pending = (async () => {
            const action = admittedAction;
            const assertMutationCurrent = () => {
              assertOwner();
              if (action === "edit" && (cleanupOnly || editsDisabled || yielding)) {
                suspended = true;
                throw new Error("Progress editing was retired");
              }
            };
            deletePending = false;
            editPending = false;
            if (action === "edit" && (cleanupOnly || editsDisabled || yielding)) {
              return;
            }
            await runWithGatewayDetachedWorkContinuation(
              () =>
                source.run(() =>
                  withPluginRuntimeGatewayContextResolver(resolveGatewayContext, async () => {
                    assertMutationCurrent();
                    read.assertSourceCurrent();
                    const requester = await read.readCurrent();
                    assertMutationCurrent();
                    if (
                      requester?.sessionId !== params.requesterSessionId ||
                      requester.lifecycleRevision !== expectedRevision ||
                      requester.archivedAt
                    ) {
                      stop();
                      throw new Error("Progress requester was reset");
                    }
                    const text = compositor.getText();
                    if (action === "edit" && (!text || text === lastText)) {
                      return;
                    }
                    const result = await runMessageAction({
                      cfg: getRuntimeConfig(),
                      action,
                      params: {
                        channel,
                        target: to,
                        accountId,
                        messageId: receipt.messageId,
                        message: text,
                        threadId: origin.threadId,
                      },
                      agentId: params.requesterAgentId,
                      sessionKey: params.requesterSessionKey,
                      requesterAccountId: accountId,
                      conversationReadOrigin: "delegated",
                      toolContext: {
                        currentChannelProvider: channel,
                        currentChannelId: String(origin.channelId ?? to),
                        currentMessagingTarget: to,
                        currentThreadTs:
                          origin.threadId === undefined ? undefined : String(origin.threadId),
                        currentMessageId:
                          origin.messageId === undefined ? undefined : String(origin.messageId),
                      },
                      gatewayOwnedDelivery: true,
                      suppressTranscriptMirror: true,
                      skipQueue: true,
                      abortSignal: signal,
                      progressSnapshot: action === "edit" ? compositor.getSnapshot() : undefined,
                      assertDirectAdapterHandoff: () => {
                        assertMutationCurrent();
                        read.assertSourceCurrent();
                      },
                      onPlatformSendDispatch: async () => {
                        assertMutationCurrent();
                        read.assertSourceCurrent();
                      },
                    });
                    if (!resolveMessageActionOutcome(result).ok) {
                      throw new Error("Progress mutation was refused");
                    }
                    if (action === "edit") {
                      lastText = text;
                    }
                  }),
                ),
              "subagents:progress",
            );
            if (action === "delete") {
              stop();
            }
          })();
          publication = pending
            .catch(() => {
              // Adapters wrap handoff errors. Preserve the local suspension fact
              // rather than mistaking intentional yield fencing for edit failure.
              if (suspended) {
                return;
              }
              if (admittedAction === "edit") {
                try {
                  assertOwner();
                  read.assertSourceCurrent();
                  // No edit replay after an ambiguous transport error. The live
                  // receipt still permits one independent terminal cleanup.
                  editsDisabled = true;
                  clearTimeout(timer);
                  timer = undefined;
                  return;
                } catch {
                  /* Revocation cannot retain cleanup authority. */
                }
              }
              stop();
            })
            .finally(() => {
              publication = undefined;
              if (deletePending) {
                publish("delete");
              } else if (editPending) {
                schedule();
              }
            });
        };
        const schedule = () => {
          if (stopped || cleanupOnly || editsDisabled || yielding || timer) {
            return;
          }
          timer = setTimeout(() => {
            timer = undefined;
            publish("edit");
          }, PROGRESS_COALESCE_MS);
          timer.unref?.();
        };
        const note = async (entry: SubagentRunRecord) => {
          const current = subagentRuns.get(entry.runId);
          if (!current || stopped || cleanupOnly) {
            return;
          }
          await compositor.pushItemEvent(projectSubagentProgressState(current));
          schedule();
        };
        const activity = (event: AgentEventPayload, itemId: string) => {
          const item = projectSubagentProgressActivity(event, lifecycle, itemId);
          if (!item || stopped || cleanupOnly || editsDisabled) {
            return;
          }
          try {
            assertOwner();
            void compositor.pushItemEvent(item).then(schedule).catch(stop);
          } catch {
            stop();
          }
        };
        const bindChildren = () => {
          for (const entry of entries) {
            presentations.set(getSubagentRunRuntimeKey(entry), presentation);
            childStops.push(
              onAgentEventForRun(entry.runId, (event) => activity(event, entry.runId + ":tool")),
            );
            void note(entry).catch(stop);
          }
        };
        const childStops: Array<() => void> = [];
        stops.push(() => {
          for (const release of childStops.splice(0)) {
            release();
          }
        });
        const presentation: Presentation = {
          promote: (next, nextGeneration) => {
            if (stopped || cleanupOnly) {
              return;
            }
            if (nextGeneration === undefined) {
              // Native yield intent suspends effects before the cohort is replaced.
              yielding = true;
              clearTimeout(timer);
              timer = undefined;
              return;
            }
            const previous = entries;
            const previousGeneration = generation;
            try {
              if (!next.length || next.length > MAX_PRESENTATION_CHILDREN) {
                throw new Error("Progress cohort exceeds bounds");
              }
              source.assertCurrent();
              entries = [...next];
              generation = nextGeneration;
              resumedCurrent = undefined;
              editsDisabled ||= entries.some(
                (entry) => entry.killIntent || entry.killReconciliation,
              );
              assertOwner();
              for (const entry of entries) {
                const other = presentations.get(getSubagentRunRuntimeKey(entry));
                if (other && other !== presentation) {
                  throw new Error("Progress cohort already presented");
                }
              }
              for (const release of childStops.splice(0)) {
                release();
              }
              for (const entry of previous) {
                if (presentations.get(getSubagentRunRuntimeKey(entry)) === presentation) {
                  presentations.delete(getSubagentRunRuntimeKey(entry));
                }
              }
              yielding = false;
              bindChildren();
            } catch {
              entries = previous;
              generation = previousGeneration;
              stop();
            }
          },
          resume: async (runId, isCurrent, run) => {
            resumedCurrent = isCurrent;
            const unsubscribe = onAgentEventForRun(runId, (event) =>
              activity(event, "requester:tool"),
            );
            try {
              assertOwner();
            } catch {
              unsubscribe();
              stop();
              return await run();
            }
            try {
              const result = await withActiveSubagentProgressContinuation(presentation, runId, run);
              if (result.delivered && result.requesterVisibleFinalDelivered === true) {
                cleanupOnly = true;
                clearTimeout(timer);
                // The Gateway work owner joins cleanup, not authoritative settlement.
                publish("delete");
              } else if (
                result.terminal ||
                result.disposition === "permanent_failure" ||
                result.disposition === "intentional_non_delivery"
              ) {
                stop();
              }
              return result;
            } catch (error) {
              stop();
              throw error;
            } finally {
              unsubscribe();
              resumedCurrent = undefined;
            }
          },
        };
        stops.push(
          sessionChanges.subscribeFacts((change) => {
            // Accounting can invalidate descriptive facts without replacing the
            // session. Every mutation rereads incarnation through its captured
            // worker source; only published revocation facts retire custody here.
            if (
              "sessionKey" in change &&
              change.sessionKey === params.requesterSessionKey &&
              (change.facts?.kind === "removed" ||
                (change.facts?.kind === "entry" &&
                  change.facts.sessionId !== params.requesterSessionId) ||
                (change.facts?.kind === "owner" &&
                  (change.facts.sessionId !== params.requesterSessionId ||
                    change.facts.lifecycleRevision !== (expectedRevision ?? null))))
            ) {
              stop();
            }
          }),
        );
        stops.push(
          subscribeSubagentRunChanges("projection", ({ runIds }) => {
            if (cleanupOnly || (runIds && !entries.some((entry) => runIds.includes(entry.runId)))) {
              return;
            }
            const cancelled = entries.map((original) => {
              const entry = subagentRuns.get(original.runId);
              return (
                isSameSubagentRunOwner(entry, original) &&
                (entry?.killIntent !== undefined || entry?.killReconciliation !== undefined)
              );
            });
            if (cancelled.every(Boolean)) {
              cleanupOnly = true;
              clearTimeout(timer);
              timer = undefined;
              publish("delete");
              return;
            }
            if (cancelled.some(Boolean)) {
              editsDisabled = true;
              clearTimeout(timer);
              timer = undefined;
            }
            if (yielding) {
              if (
                entries.some(
                  (entry) => !isSameSubagentRunOwner(subagentRuns.get(entry.runId), entry),
                )
              ) {
                stop();
              }
              return;
            }
            try {
              assertOwner();
              if (!editsDisabled) {
                for (const entry of entries) {
                  void note(entry).catch(stop);
                }
              }
            } catch {
              stop();
            }
          }),
        );
        bindChildren();
        const sourceRevoked = () => {
          stop();
        };
        const gatewayRevoked = () => {
          stop();
        };
        source.signal.addEventListener("abort", sourceRevoked, { once: true });
        stops.push(() => source.signal.removeEventListener("abort", sourceRevoked));
        signal.addEventListener("abort", gatewayRevoked, { once: true });
        stops.push(() => signal.removeEventListener("abort", gatewayRevoked));
        sourceTransferred = true;
        return true;
      } catch {
        return false;
      } finally {
        if (!sourceTransferred) {
          cleanupSource?.release();
        }
      }
    },
  };
}

/** One dispatch boundary owns completion source, promoted cron authority, and presentation. */
export async function withSubagentProgressContinuation(
  params: {
    entries: readonly SubagentRunRecord[];
    runId: string;
    requesterSessionKey: string;
    requesterAgentId?: string;
    requesterSessionId: string;
    rearmGeneration?: number;
    isCurrent: () => boolean;
  },
  run: () => Promise<SubagentAnnounceDeliveryResult>,
): Promise<SubagentAnnounceDeliveryResult> {
  const dispatch = () =>
    subagentRuns.runWithCompletionBatchAuthority(params.entries, () =>
      withRequesterCronAuthority(
        {
          requesterSessionKey: params.requesterSessionKey,
          requesterAgentId: params.requesterAgentId,
          requesterSessionId: params.requesterSessionId,
          batch: params.entries,
          rearmGeneration: params.rearmGeneration,
          runId: params.runId,
          isCurrent: params.isCurrent,
        },
        run,
      ),
    );
  const first = params.entries[0];
  const presentation = first && presentations.get(getSubagentRunRuntimeKey(first));
  return presentation ? presentation.resume(params.runId, params.isCurrent, dispatch) : dispatch();
}
