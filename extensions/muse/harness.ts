import { realpath } from "node:fs/promises";
import type { ApprovalHandler, Session, Turn } from "@muse-code/sdk";
import {
  createAgentHarnessAttemptLifecycle,
  emitAgentHarnessAttemptEvent,
  resolveAgentHarnessHistoryLimits,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  AgentHarnessPreflightError,
  agentHarnessAttemptTerminal,
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  execPolicy,
  resolveBootstrapContextForRun,
  setActiveEmbeddedRun,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
  type AgentHarnessV2,
  type AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createNativeSessionCommitFinalizer } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import {
  resolveAgentConfig,
  resolveSessionAgentIdsStrict,
} from "openclaw/plugin-sdk/agent-scope-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  loadExecApprovalsReadOnlyAsync,
  resolveExecApprovalsFromFile,
} from "openclaw/plugin-sdk/exec-approvals-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  consumeTurn,
  recordMuseTranscriptGroup,
  projectMuseAttemptResult,
  collectMuseHistoricalItemIds,
  createMuseInput,
} from "./src/events.js";
import { MusePool, openMuseSession, retainMuseSession } from "./src/runtime.js";
import { MuseCatalogReader } from "./src/verify-setup.js";

export type MuseSessionBinding = { sessionId: string; compatibility: string };
export type MuseHarnessOptions = {
  binaryPath?: string;
  sessionStore: Pick<PluginStateKeyedStore<MuseSessionBinding>, "lookup" | "register" | "delete">;
  logger?: Pick<PluginLogger, "warn">;
};

/** Configuration Muse cannot honor; the message is safe and actionable for the chat user. */
function museRefusal(message: string): AgentHarnessPreflightError {
  return new AgentHarnessPreflightError(message, { scope: "harness", userMessage: message });
}

function createMuseApprovalHandler(
  params: AgentHarnessAttemptParamsV2,
  recordFailure: (error: Error) => void,
  assertCurrent: () => void,
): ApprovalHandler {
  return async (request) => {
    assertCurrent();
    const timeoutMs = Math.min(120_000, params.timeoutMs);
    const { subject, toolName } = request;
    let decision: string | null | undefined;
    try {
      // The host schema bounds titles to 80, descriptions to 512, and details
      // to 16,384 characters; native commands can exceed these limits.
      const answer = await params.hostCapabilities.requestApproval({
        title: `Muse: ${toolName}`.slice(0, 80),
        description: (subject.command ?? subject.path ?? subject.host ?? toolName).slice(0, 512),
        ...(request.rawArgs ? { detail: request.rawArgs.slice(0, 16_384) } : {}),
        toolName,
        toolCallId: request.toolCallId,
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs,
        signal: params.abortSignal,
      });
      decision = answer?.decision;
      if (answer?.id && decision == null) {
        decision = (
          await params.hostCapabilities.waitForApproval({
            approvalId: answer.id,
            timeoutMs,
            signal: params.abortSignal,
          })
        )?.decision;
      }
    } catch (error) {
      // A current owner may fail closed using a choice Muse actually offered.
      // Revoked authority cannot make even that native decision.
      assertCurrent();
      const refusal = selectApprovalChoice(request, "deny");
      recordFailure(new Error(`Muse approval failed: ${formatErrorMessage(error)}`));
      return refusal;
    }
    assertCurrent();
    return selectApprovalChoice(request, decision);
  };
}

function selectApprovalChoice(
  request: Parameters<ApprovalHandler>[0],
  decision: string | null | undefined,
) {
  const wanted = decision === "allow-once" ? "approved" : "denied";
  const choice =
    request.availableChoices.find(
      (candidate) => candidate.decision === wanted && candidate.scope === "once",
    ) ??
    (wanted === "denied"
      ? request.availableChoices.find(
          (candidate) => candidate.decision === "denied" || candidate.decision === "abort",
        )
      : undefined);
  if (!choice) {
    throw new Error(`Muse offered no safe ${wanted} approval choice`);
  }
  return { choiceId: choice.choiceId };
}

export function createMuseAgentHarness(options: MuseHarnessOptions): AgentHarnessV2 {
  const pool = new MusePool(options.binaryPath);
  const catalogReader = new MuseCatalogReader();
  const queue = new KeyedAsyncQueue();
  const active = new Map<string, () => Promise<void>>();
  const inFlight = new Set<Promise<unknown>>();
  const catalogs = new Map<string, { workspaceDir: string; models: Set<string> }>();
  const catalogAbort = new AbortController();
  let disposed = false;

  async function runAttempt(
    params: AgentHarnessAttemptParamsV2,
  ): Promise<AgentHarnessAttemptResult> {
    const operation = queue.enqueue(params.sessionId, async () => {
      if (disposed) {
        throw new Error("Muse harness has been disposed.");
      }
      params.hostCapabilities.assertActive();
      params.abortSignal?.throwIfAborted();
      // Core admits a restricted tool policy only after native-runtime consent
      // (assertPluginHarnessConversationToolPolicySupport). Muse exposes no
      // OpenClaw tools, so a consented restriction has nothing left to filter.
      if (params.sandbox || params.requireWorkspaceOnly) {
        throw museRefusal(
          "Muse cannot enforce this OpenClaw sandbox or workspace-only policy. Select the openclaw runtime for this session.",
        );
      }
      if (params.thinkLevel === "adaptive") {
        throw museRefusal(
          "Muse does not support adaptive reasoning; choose a fixed thinking level.",
        );
      }
      const target = params.sessionTarget;
      if (!target?.sessionId || !target.sessionKey || !target.storePath) {
        throw new Error("Muse requires an exact OpenClaw transcript target.");
      }
      const transcriptTarget = {
        ...target,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      };
      let apiKey = params.resolvedApiKey;
      if (!apiKey && params.authProfileId) {
        const auth = await resolveApiKeyForProvider({
          provider: "meta",
          profileId: params.authProfileId,
          lockedProfile: true,
          store: params.authProfileStore,
          cfg: params.config,
          agentDir: params.agentDir,
          signal: params.abortSignal,
        });
        if (!auth.apiKey) {
          throw museRefusal("The selected meta auth profile has no API key usable by Muse.");
        }
        apiKey = auth.apiKey;
      }
      params.hostCapabilities.assertActive();
      const workspace = await realpath(params.workspaceDir);
      params.hostCapabilities.assertActive();
      const { sessionAgentId } = resolveSessionAgentIdsStrict({
        sessionKey: params.sessionKey,
        config: params.config,
        agentId: params.agentId,
      });
      const agentExec = resolveAgentConfig(
        params.config ?? {},
        params.sandboxAgentId ?? sessionAgentId,
      )?.tools?.exec;
      const fullSession = params.permissionMode === "full";
      let policy = execPolicy.resolveExecModePolicy({
        security: "full",
        ask: fullSession ? "off" : "on-miss",
      });
      const policyLayers = fullSession
        ? [params.execOverrides]
        : [params.config?.tools?.exec, agentExec, params.execOverrides];
      for (const layer of policyLayers) {
        policy = execPolicy.resolveExecModePolicy({
          mode: layer?.mode,
          security: layer?.security ?? policy.security,
          ask: layer?.ask ?? policy.ask,
        });
      }
      // Only explicit full-session elevation bypasses the host approval floors.
      if (!fullSession || policy.security !== "full") {
        const approvals = await loadExecApprovalsReadOnlyAsync();
        params.hostCapabilities.assertActive();
        const floors = resolveExecApprovalsFromFile({
          file: approvals,
          agentId: params.sandboxAgentId ?? sessionAgentId,
          overrides: { security: policy.security, ask: policy.ask },
        }).agent;
        policy = execPolicy.resolveExecModePolicy({
          security: execPolicy.minSecurity(policy.security, floors.security),
          ask: execPolicy.maxAsk(policy.ask, floors.ask),
        });
      }
      const { security, ask } = policy;
      if (security === "allowlist") {
        throw museRefusal(
          "Muse cannot enforce OpenClaw's exec allowlist. Use the openclaw runtime.",
        );
      }
      if (ask === "always") {
        throw museRefusal(
          "Muse cannot enforce exec ask: always for every native command. Use ask: on-miss/default, or the openclaw runtime.",
        );
      }
      const readOnly = security === "deny";
      const approvalMode = readOnly
        ? "denyUnmatched"
        : security === "full" && ask === "off"
          ? "allowAll"
          : "promptUnmatched";
      params.hostCapabilities.prepareContinuationRetryCount?.({ cwd: workspace });
      const lease = await pool.acquire(workspace, apiKey, readOnly);
      const { runtime } = lease;
      const compatibility = JSON.stringify([
        workspace,
        params.modelId,
        runtime.credentialIdentity,
        readOnly,
        approvalMode,
      ]);
      let session: Session | undefined;
      let turn: Turn | undefined;
      let submitCommandId: string | undefined;
      let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let aborted = false;
      let abortPromise: Promise<void> | undefined;
      let failure: unknown;
      let unsettledApprovalFailure = false;
      let activeAttachment: ReturnType<typeof setActiveEmbeddedRun> | undefined;
      const messages: AgentMessage[] = [];
      let text = "";
      let lastToolError: AgentHarnessAttemptResult["lastToolError"];
      let assistantTranscriptOwned = false;
      const lifecycle = createAgentHarnessAttemptLifecycle({
        attempt: params,
        backend: "muse",
        startedAtMs: params.startedAtMs ?? Date.now(),
        state: { lifecycleStarted: false, lifecycleTerminalEmitted: false },
        emitEvent: (event) =>
          emitAgentHarnessAttemptEvent(params, event, { label: "Muse", log: embeddedAgentLog }),
      });
      let finalKey: string | undefined;
      const bound = params.hostCapabilities.bindModelExecution?.({
        provider: "meta",
        model: params.modelId,
      });
      const signal = bound
        ? AbortSignal.any([bound.signal, ...(params.abortSignal ? [params.abortSignal] : [])])
        : params.abortSignal;
      const projectionAbort = new AbortController();
      const projectionSignal = AbortSignal.any([
        projectionAbort.signal,
        ...(signal ? [signal] : []),
      ]);
      const ownsTurn = () => {
        if (!session || !turn || !submitCommandId) {
          return false;
        }
        // A materialized user-message echo can retire the pending ack; the fold
        // still records which command started the turn.
        return (
          session.pending.get(submitCommandId)?.ack?.disposition === "started" ||
          session.fold.turn(turn.turnId)?.commandId === submitCommandId
        );
      };
      const assertDispatchActive = () => {
        params.hostCapabilities.assertActive();
        bound?.assertCurrent();
        projectionSignal.throwIfAborted();
        if (aborted) {
          throw new Error("Muse attempt was aborted before turn dispatch.");
        }
      };
      const stop = async () => {
        if (!session || !turn) {
          return;
        }
        const nativeState = session.fold.turn(turn.turnId)?.state;
        if (nativeState === "settled" || nativeState === "unqueued") {
          return;
        }
        if (!ownsTurn()) {
          projectionAbort.abort(failure ?? new Error("Muse attempt detached from native work"));
          return;
        }
        if (!abortPromise) {
          // An interrupt ack is not settlement. Retire an unresponsive host so
          // cancellation cannot leave a turn waiting indefinitely.
          forceCloseTimer = setTimeout(() => {
            void runtime.close();
          }, 5000);
          forceCloseTimer.unref();
          const nativeTurn = turn;
          abortPromise = (async () => {
            await runtime.host.connection
              .command("turn/interrupt", {
                sessionId: session.sessionId,
                turnId: nativeTurn.turnId,
              })
              .catch(() => runtime.close());
            await nativeTurn.completed;
          })();
        }
        await abortPromise;
      };
      const abort = async () => {
        aborted = true;
        await stop();
        projectionAbort.abort(new Error(timedOut ? "Muse turn timed out" : "Muse attempt aborted"));
      };
      const onAbort = () => {
        void abort().catch(() => runtime.close());
      };
      const handle = {
        kind: "embedded" as const,
        runId: params.runId,
        startedAtMs: params.startedAtMs,
        // Core matches this against the attempt before granting tool authority.
        toolAuthorityFingerprint: params.toolAuthorityFingerprint,
        queueMessage: async () => {
          throw new Error("Muse live steering is not supported; wait for the active turn.");
        },
        isStreaming: () => !aborted,
        isAborted: () => aborted,
        isCompacting: () => false,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        cancel: onAbort,
        abort,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // Gateway turns pass an unlimited budget as a value at or above the
      // largest Node timer; setTimeout would overflow it into an immediate fire.
      const timer =
        params.timeoutMs < MAX_TIMER_TIMEOUT_MS
          ? setTimeout(() => {
              timedOut = true;
              params.onAttemptTimeout?.(new Error("Muse turn timed out"));
              onAbort();
            }, params.timeoutMs)
          : undefined;
      timer?.unref();
      try {
        assertDispatchActive();
        const stored = await options.sessionStore.lookup(params.sessionId);
        assertDispatchActive();
        const resumable =
          stored &&
          stored.compatibility === compatibility &&
          !params.initialReplayState?.replayInvalid;
        let freshSession = !resumable;
        session = await openMuseSession(runtime, {
          ...(resumable ? { sessionId: stored.sessionId } : {}),
          workspace,
          modelId: params.modelId,
          approvalMode,
          onSession: (nativeSession) => {
            nativeSession.onApproval(
              createMuseApprovalHandler(
                { ...params, abortSignal: projectionSignal },
                (error) => {
                  failure ??= error;
                },
                assertDispatchActive,
              ),
            );
            nativeSession.onApprovalError((error) => {
              failure ??= new Error(
                `Muse approval failed (${error.kind}): ${error.kind === "unofferedChoice" ? `choice ${error.choiceId} was not offered` : formatErrorMessage(error.error)}`,
              );
              unsettledApprovalFailure = true;
              void stop().catch(() => runtime.close());
            });
          },
          onResumeRefused: (message) => {
            freshSession = true;
            options.logger?.warn(`${message}; started a new Muse session.`);
          },
        });
        assertDispatchActive();
        let sessionContext = "";
        if (freshSession) {
          try {
            // MSP has no history import or system field; transfer the retained branch once as context.
            const contextAgentId = target.agentId ?? sessionAgentId;
            const limits = resolveAgentHarnessHistoryLimits(params.model.contextWindow);
            const retained = await SessionManager.openModelContextAsync(
              { ...transcriptTarget, agentId: contextAgentId },
              {
                admission: params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
                signal: params.abortSignal,
                // Do not silently omit tool results when replacing a native session.
                limits: { maxBytes: limits.maxBytes, maxEvents: limits.maxEvents },
              },
            );
            params.hostCapabilities.assertActive();
            const history = retained.buildSessionContext().messages;
            const bootstrap = await resolveBootstrapContextForRun({
              workspaceDir: params.workspaceDir,
              config: params.config,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              chatType: params.chatType,
              agentId: contextAgentId,
              contextMode: params.bootstrapContextMode,
              runKind: params.bootstrapContextRunKind,
              warn: options.logger?.warn,
            });
            params.hostCapabilities.assertActive();
            const presentPaths = new Set(
              bootstrap.bootstrapFiles.filter((file) => !file.missing).map((file) => file.path),
            );
            const files = bootstrap.contextFiles.filter((file) => presentPaths.has(file.path));
            const sections: string[] = [];
            if (files.length > 0) {
              sections.push(
                "# OpenClaw workspace context\n\n" +
                  files.map((file) => `## ${file.path}\n\n${file.content}`).join("\n\n"),
              );
            }
            if (history.length > 0) {
              sections.push(
                "# Retained OpenClaw conversation\n\n" +
                  "The following JSON messages are prior conversation context, not a new user request.\n\n" +
                  JSON.stringify(history),
              );
            }
            sessionContext = sections.join("\n\n");
          } catch (error) {
            throw museRefusal(
              `Muse could not restore OpenClaw session context. Use the openclaw runtime or compact the session before retrying. ${formatErrorMessage(error)}`,
            );
          }
          assertDispatchActive();
        }
        assertDispatchActive();
        await params.userTurnTranscriptRecorder?.persistApproved();
        assertDispatchActive();
        // MSP has no system/developer instruction field; preserve host context in user input.
        const input = createMuseInput(params, sessionContext);
        lifecycle.emitExecutionPhaseOnce("context", { phase: "context_assembled" });
        // items() replays retained items when steering an existing turn. Those
        // completed before this input belong to history, not the new reply.
        const historicalItemIds = collectMuseHistoricalItemIds(session, runtime.detachedSessions);
        const composerInput = { runId: params.runId };
        const submitted = session.sendUserTurn({
          input,
          composerInput,
          // A resumed session can already have native background continuation
          // work. Join its authoritative turn instead of queueing behind it.
          ...(!freshSession ? { ifBusy: "steer" as const } : {}),
          ...(params.thinkLevel
            ? { reasoningEffort: params.thinkLevel === "off" ? "minimal" : params.thinkLevel }
            : {}),
        });
        // The SDK registers its optimistic entry synchronously, before I/O.
        // Retain that command identity even if its user-message echo retires it.
        submitCommandId = session.pending
          .list()
          .find((entry) => entry.input === composerInput)?.commandId;
        turn = await submitted;
        lifecycle.emitLifecycleStart({ provider: "meta", model: params.modelId });
        lifecycle.emitExecutionPhaseOnce("accepted", { phase: "turn_accepted" });
        // Publish the binding only once Muse accepted the turn carrying any fresh-session
        // context; an earlier failure must leave the next attempt to seed a new session.
        await options.sessionStore.register(params.sessionId, {
          sessionId: session.sessionId,
          compatibility,
        });
        if (signal?.aborted) {
          onAbort();
        } else if (unsettledApprovalFailure) {
          // An approval can fail before sendUserTurn resolves; interrupt now that the turn exists.
          void stop().catch(() => runtime.close());
        }
        activeAttachment = setActiveEmbeddedRun(
          params.sessionId,
          handle,
          params.sessionKey,
          params.sessionFile,
          sessionAgentId,
        );
        active.set(params.sessionId, abort);
        params.onExecutionStarted?.({ backend: "muse" });
        const nativeSessionId = session.sessionId;
        const observation = { ...params, abortSignal: projectionSignal };
        const result = await consumeTurn(
          turn,
          observation,
          async (itemId, group, historical) => {
            const key = await recordMuseTranscriptGroup({
              params: observation,
              target: transcriptTarget,
              nativeSessionId,
              itemId,
              group,
              historical,
            });
            if (!historical) {
              finalKey = key ?? finalKey;
              messages.push(...group);
              assistantTranscriptOwned = finalKey !== undefined;
            }
          },
          historicalItemIds,
        );
        text = result.visibleText;
        lastToolError = result.lastToolError;
        if (result.outcome.kind !== "completed") {
          throw new Error(`Muse turn ended without a terminal result (${result.outcome.kind}).`);
        }
        if (result.outcome.params.terminal === "failed") {
          const turnError = result.outcome.params.error;
          throw new Error(
            turnError?.kind === "authRequired"
              ? `Muse Code is not signed in on the Gateway host (${turnError.message}). Run \`muse login\` there, or set META_API_KEY for the Gateway.`
              : (turnError?.message ??
                  result.outcome.params.reason ??
                  "Muse model request failed. Run muse to check login and model access."),
          );
        }
        // A cancellation the harness started for a failure (such as an approval
        // error) reports that failure, not an external abort.
        if (result.outcome.params.terminal === "cancelled" && !failure) {
          aborted = true;
        }
        lifecycle.emitLifecycleTerminal({ phase: "end" });
      } catch (error) {
        if ((signal?.aborted || projectionAbort.signal.aborted) && !failure) {
          // The caller's abort, not a Muse failure, ended this attempt.
          aborted = true;
        } else {
          failure ??= error;
        }
        if (turn) {
          await stop().catch(() => undefined);
        }
        lifecycle.emitLifecycleTerminal({
          phase: failure ? "error" : "end",
          ...(failure ? { error: failure } : {}),
        });
      } finally {
        const detached = projectionAbort.signal.aborted;
        projectionAbort.abort(new Error("Muse observation is no longer active."));
        // Session outlives this model observation. Never leave its callbacks
        // holding caller approval authority after the binding is released.
        session?.onApproval(async () => {
          throw new Error("Muse observation is no longer active.");
        });
        session?.onApprovalError(() => {});
        await abortPromise?.catch(() => undefined);
        clearTimeout(timer);
        clearTimeout(forceCloseTimer);
        signal?.removeEventListener("abort", onAbort);
        active.delete(params.sessionId);
        clearActiveEmbeddedRun(
          params.sessionId,
          handle,
          params.sessionKey,
          params.sessionFile,
          undefined,
          activeAttachment,
        );
        bound?.release();
        if (session && turn && !ownsTurn() && detached) {
          // Detached observation releases caller authority above. Retain only
          // the process lease so idle shutdown cannot kill the joined work.
          retainMuseSession(
            runtime,
            session,
            turn.completed,
            lease.release,
            unsettledApprovalFailure,
          );
        } else {
          lease.release();
        }
      }
      const interruption = timedOut
        ? { kind: "timeout" as const, phase: "prompt" as const, source: "runtime" as const }
        : aborted
          ? { kind: "aborted" as const, source: "external" as const }
          : { kind: "ok" as const };
      const failureMessage = failure
        ? // Muse reports credential rejection (for example an invalid
          // META_API_KEY) only on stderr; the turn itself says "not logged in".
          `Muse Code: ${formatErrorMessage(failure)}${runtime.host.child.stderrTail.length ? `\nRecent Muse stderr:\n${runtime.host.child.stderrTail.slice(-5).join("\n")}` : ""}`
        : undefined;
      if (failureMessage) {
        // Chat surfaces show a generic failure; the Gateway log keeps the actionable cause.
        options.logger?.warn(failureMessage);
      }
      const terminal = failureMessage
        ? agentHarnessAttemptTerminal.setFailure(interruption, {
            source: "prompt",
            error: new Error(failureMessage),
          })
        : interruption;
      return projectMuseAttemptResult({
        params,
        messages,
        terminal,
        text,
        failed: Boolean(failure),
        assistantTranscriptOwned,
        finalKey,
        lastToolError,
      });
    });
    inFlight.add(operation);
    try {
      return await operation;
    } finally {
      inFlight.delete(operation);
    }
  }

  return {
    id: "muse",
    label: "Muse Code",
    autoSelection: { providerIds: [] },
    authBootstrap: "harness",
    executionEnvironment: "host-only",
    verifySetup: (ctx) => catalogReader.verify(ctx),
    async loadModelCatalog(params) {
      catalogs.delete(params.agentDir);
      const request = catalogReader.read({
        config: params.config,
        signal: AbortSignal.any([catalogAbort.signal, AbortSignal.timeout(30_000)]),
        assertCurrent: () => {
          if (disposed) {
            throw new Error("Muse harness has been disposed.");
          }
        },
      });
      inFlight.add(request);
      try {
        const entries = await request;
        catalogs.set(params.agentDir, {
          workspaceDir: params.workspaceDir,
          models: new Set(entries.map((entry) => entry.id)),
        });
        return entries;
      } finally {
        inFlight.delete(request);
      }
    },
    readModelCatalogReadiness(params) {
      const catalog = catalogs.get(params.agentDir);
      return !disposed &&
        params.provider === "meta" &&
        catalog?.workspaceDir === params.workspaceDir &&
        catalog.models.has(params.modelId)
        ? { accountType: "native" }
        : undefined;
    },
    conversationToolPolicyNativeTools: ["exec", "read", "write", "edit"],
    supports: (ctx) =>
      ctx.requestedRuntime === "muse" &&
      ctx.provider === "meta" &&
      ctx.modelProvider?.requestTransportOverrides !== "present" &&
      // Muse always calls Meta itself, so only an endpoint other than Meta's
      // official one is a route Muse cannot reproduce. Setup probes report the
      // catalog default as an authored endpoint.
      (ctx.modelProvider?.endpointOverrides !== "present" ||
        ctx.modelProvider.baseUrl?.replace(/\/+$/u, "") === "https://api.meta.ai/v1")
        ? { supported: true, priority: 100 }
        : {
            supported: false,
            reason: "Muse requires an explicit muse runtime and Meta's official API endpoint.",
          },
    runAttempt,
    async withSessionContextReset(params, run) {
      params.assertCurrent();
      await active.get(params.sessionId)?.();
      return queue.enqueue(params.sessionId, async () => {
        params.assertCurrent();
        let committed = false;
        const result = await run(
          createNativeSessionCommitFinalizer({
            commit: () => {
              committed = true;
            },
            rollback: () => undefined,
          }),
        );
        if (committed) {
          params.assertCurrent();
          await options.sessionStore.delete(params.sessionId);
        }
        return result;
      });
    },
    async reset(params) {
      const sessionId = params.sessionId;
      if (!sessionId) {
        return;
      }
      await active.get(sessionId)?.();
      await queue.enqueue(sessionId, async () => {
        await options.sessionStore.delete(sessionId);
      });
    },
    async dispose() {
      disposed = true;
      catalogAbort.abort();
      catalogs.clear();
      await Promise.allSettled([...active.values()].map((abort) => abort()));
      await Promise.allSettled(inFlight);
      await pool.dispose();
      await catalogReader.dispose();
    },
  };
}
