import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  agentHarnessAttemptTerminal,
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  setActiveEmbeddedRun,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { calculateCost, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { AgentsApiClient, type AgentsApiEvent } from "./agentsapi-client.js";
import { collectOutputs, prepareInputs, uploadInputs } from "./agentsapi-files.js";
import {
  commitAgentsApiAssistant,
  createAgentsApiSnapshotEmitter,
  createAgentsApiUsage,
  emitAgentsApiEvent,
  selectAgentsApiReplyText,
  updateAgentsApiUsage,
} from "./agentsapi-reply.js";
import { buildAgentsApiToolSurface } from "./agentsapi-tools.js";

type SessionBinding = { sessionId: string; authFingerprint: string };

/** Session IDs survive Gateway restarts in the existing plugin SQLite store. */
export function agentsApiBindingStore(runtime: PluginRuntime) {
  return runtime.state.openSyncKeyedStore<SessionBinding>({
    namespace: "agentsapi-sessions",
    maxEntries: 100_000,
    overflowPolicy: "reject-new",
  });
}

export async function runAgentsApiAttempt(
  params: AgentHarnessAttemptParamsV2,
  runtime: PluginRuntime,
  assertHarnessCurrent: () => void,
): Promise<AgentHarnessAttemptResult> {
  const assertCurrent = () => {
    assertHarnessCurrent();
    params.hostCapabilities.assertActive();
  };
  assertCurrent();
  const { agentId, sessionId, sessionKey, storePath } = params.sessionTarget ?? {};
  if (
    !agentId ||
    !sessionId ||
    !sessionKey ||
    !storePath ||
    sessionId !== params.sessionId ||
    agentId !== params.agentId ||
    sessionKey !== params.sessionKey
  ) {
    throw new Error("Agents API requires a matching host-prepared session target");
  }
  const sessionTarget = { ...params.sessionTarget, agentId, sessionId, sessionKey, storePath };
  if (!params.resolvedApiKey) {
    throw new Error("Agents API MVP requires an OpenAI API key");
  }
  if (params.images?.length || params.sandbox) {
    throw new Error(
      "Agents API MVP supports text and its hosted VM only; images and Gateway sandbox placement are unsupported",
    );
  }
  if (params.contextEngine && params.contextEngine.info.id !== "legacy") {
    throw new Error("Agents API MVP currently supports only the default legacy context engine");
  }
  assertCurrent();
  const controller = new AbortController();
  let streamController = new AbortController();
  let stage = "prepare_session";
  const client = new AgentsApiClient(params.resolvedApiKey, assertCurrent);
  // Cancellation retires already admitted remote work even after host authority closes.
  const cleanupClient = new AgentsApiClient(params.resolvedApiKey, assertHarnessCurrent);
  const store = agentsApiBindingStore(runtime);
  let binding = store.lookup(params.sessionId);
  let remoteSessionId = binding?.sessionId;
  let submitted = false;
  let stopped = false;
  let interrupted = false;
  let timedOut = false;
  let cancellation: Promise<void> | undefined;
  let submission: Promise<void> = Promise.resolve();
  let admittedMessageCount = 0;
  const observedInputItems = new Set<string>();
  const coordinatorTurnIds = new Set<string>();
  let latestInputTurnId: string | undefined;
  const submit = (text: string) => {
    assertCurrent();
    if (!remoteSessionId || stopped || sessionSettled || rootTurn) {
      throw new Error("Agents API turn is stopped");
    }
    const submittedSessionId = remoteSessionId;
    submission = submission.then(() => {
      if (sessionSettled || rootTurn) {
        throw new Error("Agents API turn settled before steering was submitted");
      }
      admittedMessageCount++;
      return client.message(submittedSessionId, text, AbortSignal.timeout(60_000));
    });
    void submission.catch(() => {});
    return submission;
  };
  let terminal: ReturnType<typeof agentHarnessAttemptTerminal.normalize> = { kind: "ok" };
  let rootTurn: AgentsApiEvent["turn"];
  let sessionSettled = false;
  let reconciledStream = false;
  let turnFailure: string | undefined;
  const texts = new Map<string, Map<number, string>>();
  const assistantPhases = new Map<string, string | null | undefined>();
  const emitAssistantSnapshot = createAgentsApiSnapshotEmitter(params);
  let usage = createAgentsApiUsage();
  const stop = (requested = true) => {
    if (stopped) {
      return;
    }
    stopped = true;
    interrupted = requested;
    if (requested) {
      params.onAttemptAbort?.();
    }
    controller.abort(new Error("Agents API turn interrupted"));
    if (remoteSessionId && submitted) {
      const cancelledSessionId = remoteSessionId;
      const admittedSubmission = submission;
      cancellation = (async () => {
        // Do not abort an admitted POST: cancel only after its response settles.
        // An uncertain submission remains a failure even if cancellation succeeds.
        let submissionError: unknown;
        try {
          await admittedSubmission;
        } catch (error) {
          submissionError = error;
        }
        await cleanupClient.cancel(cancelledSessionId, AbortSignal.timeout(30_000));
        if (submissionError) {
          throw submissionError instanceof Error
            ? submissionError
            : new Error(formatErrorMessage(submissionError), { cause: submissionError });
        }
      })();
      // The settlement barrier below observes errors; attach immediately to prevent unhandled rejection.
      void cancellation.catch(() => {});
    }
  };
  const handle = {
    kind: "embedded" as const,
    toolAuthorityFingerprint: params.toolAuthorityFingerprint,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    supportsTranscriptCommitWait: true,
    runId: params.runId,
    startedAtMs: Date.now(),
    queueMessage: async (
      text: string,
      options?: Parameters<Parameters<typeof setActiveEmbeddedRun>[1]["queueMessage"]>[1],
    ) => {
      assertCurrent();
      if (stopped || sessionSettled || rootTurn || !remoteSessionId || !submitted) {
        throw new Error("Agents API turn is not ready for steering");
      }
      if (options?.images?.length) {
        throw new Error("Agents API MVP accepts text steering only");
      }
      await options?.userTurnTranscriptRecorder?.persistApproved();
      assertCurrent();
      await submit(text);
      options?.userTurnTranscriptRecorder?.markSentToProvider?.();
    },
    isStreaming: () => submitted && !stopped && !sessionSettled && !rootTurn,
    isStopped: () => stopped || sessionSettled || Boolean(rootTurn),
    isAborted: () => stopped,
    isCompacting: () => false,
    abort: () => stop(),
    cancel: () => stop(),
  };
  const onAbort = () => stop();
  params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  params.onAttemptDeadlineChanged?.({
    kind: "bounded",
    deadlineAtMs: Date.now() + params.timeoutMs,
  });
  const timer = setTimeout(() => {
    timedOut = true;
    params.onAttemptTimeout?.(new Error("Agents API attempt timed out"));
    stop();
  }, params.timeoutMs);
  params.replyOperation?.attachBackend(handle);
  setActiveEmbeddedRun(
    params.sessionId,
    handle,
    params.sessionKey,
    params.sessionFile,
    params.agentId,
  );
  let lastAssistant: AssistantMessage | undefined;
  const toolCleanups: Array<(reason: string) => Promise<void>> = [];
  let toolSurface: Awaited<ReturnType<typeof buildAgentsApiToolSurface>> | undefined;
  let outputMedia: Awaited<ReturnType<typeof collectOutputs>> | undefined;
  let terminatedByTool = false;
  let startedToolCount = 0;
  let completedToolCount = 0;
  try {
    if (params.abortSignal?.aborted) {
      stop();
    }
    controller.signal.throwIfAborted();
    const surface = buildAgentsApiToolSurface(params, controller.signal, assertCurrent, (cleanup) =>
      toolCleanups.push(cleanup),
    );
    toolSurface = surface;
    const inputs = await prepareInputs(
      params.media,
      params.workspaceDir,
      assertCurrent,
      controller.signal,
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([params.model.id, params.resolvedApiKey, toolSurface.declarations]))
      .digest("hex");
    assertCurrent();
    if (binding && binding.authFingerprint !== fingerprint) {
      throw new Error(
        "Agents API model, credential, or tool surface changed; reset the OpenClaw session before continuing",
      );
    }
    const creatingSession = !remoteSessionId;
    if (!remoteSessionId) {
      remoteSessionId = await client.create(
        controller.signal,
        [
          "You are the OpenClaw assistant. Use your hosted Linux workspace for commands and files.",
          "OpenClaw functions run in the Gateway and use its workspace; your hosted VM owns shell commands and VM files.",
          "Uploaded attachments are mapped to hosted VM paths in each user message. Files you finish writing under /workspace/outputs are transferred and attached to your final reply after your turn completes.",
          "Gateway messaging functions cannot open VM paths. Complete your assistant turn to deliver VM output attachments. Image generation is unavailable.",
          params.extraSystemPrompt,
        ]
          .filter(Boolean)
          .join("\n\n"),
        params.model.id,
        { functions: toolSurface.declarations, files: inputs.files },
      );
      assertCurrent();
      binding = { sessionId: remoteSessionId, authFingerprint: fingerprint };
      store.register(params.sessionId, binding);
    }
    if (!creatingSession && inputs.files.length) {
      stage = "upload_inputs";
      await uploadInputs(client, remoteSessionId, inputs.files, assertCurrent, controller.signal);
    }
    const baselineTurnId = (
      await client.turns(remoteSessionId, controller.signal, undefined, true)
    )[0]?.id;
    const nativeSessionId = remoteSessionId;
    const relayedCalls = new Set<string>();
    const relayFunctions = async () => {
      assertCurrent();
      controller.signal.throwIfAborted();
      const calls = await client.pendingFunctionCalls(nativeSessionId, controller.signal);
      if (!calls.length) {
        return;
      }
      const turns = await client.turns(nativeSessionId, controller.signal, baselineTurnId);
      for (const turn of turns) {
        coordinatorTurnIds.add(turn.id);
      }
      const latestTurn = turns.at(-1);
      if (!latestTurn) {
        throw new Error("Agents API function request has no current attempt root turn");
      }
      latestInputTurnId = latestTurn.id;
      for (const call of calls) {
        if (
          call.turn_id !== latestTurn.id ||
          !["in_progress", "waiting"].includes(latestTurn.status)
        ) {
          throw new Error(
            "Agents API function request belongs to a different or settled root turn",
          );
        }
        const identity = `${remoteSessionId}:${call.turn_id}:${call.call_id}`;
        if (relayedCalls.has(identity)) {
          continue;
        }
        // Claim before execution: neither a repeated event nor an uncertain POST
        // may run a Gateway side effect for this native call a second time.
        relayedCalls.add(identity);
        startedToolCount++;
        emitAgentsApiEvent(params, {
          stream: "tool",
          data: { phase: "start", name: call.name, toolCallId: call.call_id },
        });
        const result = await surface.execute(call);
        assertCurrent();
        controller.signal.throwIfAborted();
        submission = submission.then(() =>
          client.toolResult(nativeSessionId, call, result, AbortSignal.timeout(60_000)),
        );
        void submission.catch(() => {});
        await submission;
        completedToolCount++;
        emitAgentsApiEvent(params, {
          stream: "tool",
          data: {
            phase: "result",
            name: call.name,
            toolCallId: call.call_id,
            isError: !result.success,
          },
        });
        if (result.terminate || result.sourceReplyDelivered) {
          // The host has delivered the final reply. Acknowledge its native tool
          // result before retiring the coordinator, then suppress duplicate text.
          await cleanupClient.cancel(nativeSessionId, AbortSignal.timeout(30_000));
          const settledSession = await client.session(nativeSessionId, controller.signal);
          if (settledSession.status !== "idle") {
            throw new Error(
              settledSession.error ?? "Agents API tool termination did not establish native idle",
            );
          }
          const nativeRoot = await client.turn(nativeSessionId, call.turn_id, controller.signal);
          rootTurn = nativeRoot;
          if (!["completed", "cancelled"].includes(nativeRoot.status)) {
            throw new Error("Agents API tool termination did not settle its native root turn");
          }
          terminatedByTool = true;
          terminal = { kind: "ok" };
          sessionSettled = true;
          streamController.abort();
          return;
        }
      }
    };
    stage = "subscribe";
    let events = await client.subscribe(
      remoteSessionId,
      AbortSignal.any([controller.signal, streamController.signal]),
    );
    // Start reading before admitting input; the stream generator is otherwise lazy.
    let nextEvent = events.next();
    void nextEvent.catch(() => {});
    try {
      await params.userTurnTranscriptRecorder?.persistApproved();
      assertCurrent();
      // Mark before sending: an uncertain POST may already have started remote work.
      submitted = true;
      stage = "submit_input";
      await submit([params.prompt, inputs.mappingText].filter(Boolean).join("\n\n"));
      params.userTurnTranscriptRecorder?.markSentToProvider?.();
      emitAgentsApiEvent(params, { stream: "lifecycle", data: { phase: "start" } });
      stage = "stream";
      while (!sessionSettled) {
        const chunk = await nextEvent;
        if (chunk.done) {
          reconciledStream = true;
          // Streams do not replay missed events. Buffer a new subscription before
          // reconstructing this attempt's turns and input receipts from saved state.
          streamController.abort();
          await events.return(undefined);
          await delay(500, undefined, { signal: controller.signal });
          streamController = new AbortController();
          events = await client.subscribe(
            remoteSessionId,
            AbortSignal.any([controller.signal, streamController.signal]),
          );
          nextEvent = events.next();
          void nextEvent.catch(() => {});
          await submission;
          const admittedCount = admittedMessageCount;
          const turns = await client.turns(remoteSessionId, controller.signal, baselineTurnId);
          for (const turn of turns) {
            coordinatorTurnIds.add(turn.id);
            for (const item of await client.items(remoteSessionId, turn.id, controller.signal)) {
              if (item.type === "message" && item.role === "user") {
                observedInputItems.add(item.id);
              }
            }
          }
          const latestTurn = turns.at(-1);
          if (latestTurn) {
            latestInputTurnId = latestTurn.id;
            const completed = ["completed", "failed", "cancelled"].includes(latestTurn.status);
            rootTurn = completed ? latestTurn : undefined;
            turnFailure =
              latestTurn.status === "failed"
                ? (latestTurn.error?.message ?? "Agents API turn failed")
                : undefined;
            terminal =
              latestTurn.status === "cancelled"
                ? { kind: "aborted", source: "runtime" }
                : { kind: "ok" };
          }
          const session = await client.session(remoteSessionId, controller.signal);
          assertCurrent();
          if (session.status === "failed") {
            throw new Error(session.error ?? "Agents API session failed");
          }
          if (session.status === "requires_action") {
            await relayFunctions();
            if (sessionSettled) {
              break;
            }
          }
          if (
            rootTurn &&
            session.status === "idle" &&
            admittedCount === admittedMessageCount &&
            observedInputItems.size >= admittedMessageCount
          ) {
            sessionSettled = true;
            stage = "stream_cleanup";
            streamController.abort();
            break;
          }
          embeddedAgentLog.debug("Agents API event stream reconnected", {
            latestInputTurnId,
            status: session.status,
          });
          continue;
        }
        const event = chunk.value;
        nextEvent = events.next();
        void nextEvent.catch(() => {});
        assertCurrent();
        params.onRunProgress?.({
          reason: event.type,
          provider: "openai",
          model: params.model.id,
          backend: "agentsapi",
        });
        if (rootTurn && event.type === "agent.session.idle") {
          // An idle frame can precede acceptance of an already admitted steer.
          // Wait for every input's native item and its matching terminal turn.
          await submission;
          assertCurrent();
          if (observedInputItems.size < admittedMessageCount) {
            // Input-item frames are not the root-turn readiness contract. Reconcile
            // admitted input from canonical items before accepting a terminal idle.
            for (const turnId of coordinatorTurnIds) {
              const items = await client.items(remoteSessionId, turnId, controller.signal);
              for (const item of items) {
                if (item.type === "message" && item.role === "user") {
                  observedInputItems.add(item.id);
                }
              }
            }
          }
          if (observedInputItems.size < admittedMessageCount) {
            continue;
          }
          if (rootTurn.id !== latestInputTurnId) {
            continue;
          }
          if (reconciledStream) {
            // Buffered idle frames can belong to a turn before the recovered root.
            const session = await client.session(remoteSessionId, controller.signal);
            if (session.status === "failed") {
              throw new Error(session.error ?? "Agents API session failed");
            }
            if (session.status !== "idle") {
              continue;
            }
          }
          sessionSettled = true;
          stage = "stream_cleanup";
          // Abort the long-lived HTTP body before iterator cleanup, as the native SDK does.
          streamController.abort();
          break;
        }
        if (event.type === "agent.session.turn.created" && event.turn?.subagent_id === null) {
          if (!coordinatorTurnIds.has(event.turn.id)) {
            coordinatorTurnIds.add(event.turn.id);
            latestInputTurnId = event.turn.id;
            rootTurn = undefined;
            turnFailure = undefined;
            terminal = { kind: "ok" };
          }
        }
        if (
          (event.type === "agent.session.turn.item.added" ||
            event.type === "agent.session.turn.item.done") &&
          event.item?.type === "message" &&
          event.item.role === "user" &&
          !observedInputItems.has(event.item.id)
        ) {
          observedInputItems.add(event.item.id);
          const inputTurnId = event.item.turn_id ?? event.turn_id;
          if (!inputTurnId) {
            throw new Error("Agents API input item is missing its turn ID");
          }
          if (!latestInputTurnId) {
            coordinatorTurnIds.add(inputTurnId);
            latestInputTurnId = inputTurnId;
          }
        }
        if (event.type === "error") {
          throw new Error(event.error?.message ?? "Agents API stream error");
        }
        if (event.type === "agent.session.requires_action") {
          await relayFunctions();
          if (sessionSettled) {
            break;
          }
          continue;
        }
        if (["agent.session.failed", "agent.session.environment.failed"].includes(event.type)) {
          throw new Error(`Agents API MVP cannot continue: ${event.type}`);
        }
        if (event.item?.type === "message" && event.item.role === "assistant") {
          assistantPhases.set(event.item.id, event.item.phase);
          if (event.type === "agent.session.turn.item.done") {
            const parts = new Map<number, string>();
            event.item.content?.forEach((part, index) => {
              if (part.type === "output_text") {
                parts.set(index, part.text ?? "");
              }
            });
            texts.set(event.item.id, parts);
          }
          const parts = texts.get(event.item.id);
          if (event.item.phase !== "commentary" && parts) {
            emitAssistantSnapshot(
              `agentsapi:${remoteSessionId}:${event.item.id}`,
              [...parts.entries()]
                .toSorted(([left], [right]) => left - right)
                .map(([, text]) => text)
                .join(""),
            );
          }
        }
        if (
          event.type === "agent.session.turn.output_text.delta" ||
          event.type === "agent.session.turn.output_text.done"
        ) {
          if (!event.item_id) {
            throw new Error("Agents API text event has no item identity");
          }
          const parts = texts.get(event.item_id) ?? new Map<number, string>();
          const index = event.content_index ?? 0;
          parts.set(
            index,
            event.type.endsWith(".done")
              ? (event.text ?? "")
              : (parts.get(index) ?? "") + (event.delta ?? ""),
          );
          texts.set(event.item_id, parts);
          if (
            assistantPhases.has(event.item_id) &&
            assistantPhases.get(event.item_id) !== "commentary"
          ) {
            emitAssistantSnapshot(
              `agentsapi:${remoteSessionId}:${event.item_id}`,
              [...parts.entries()]
                .toSorted(([left], [right]) => left - right)
                .map(([, text]) => text)
                .join(""),
              event.delta ?? "",
            );
          }
        }
        if (
          event.type.startsWith("agent.session.turn.") &&
          event.turn?.subagent_id === null &&
          event.turn.id === latestInputTurnId &&
          [
            "agent.session.turn.completed",
            "agent.session.turn.failed",
            "agent.session.turn.cancelled",
          ].includes(event.type)
        ) {
          rootTurn = event.turn;
          if (event.type.endsWith(".failed")) {
            turnFailure = event.turn.error?.message ?? "Agents API turn failed";
          }
          if (event.type.endsWith(".cancelled")) {
            terminal = { kind: "aborted", source: "runtime" };
          }
        }
      }
    } finally {
      streamController.abort();
      await events.return(undefined);
    }
    if (!rootTurn || !sessionSettled) {
      throw new Error(
        "Agents API stream closed before the root turn settled; reset or inspect the session before retrying",
      );
    }
    if (turnFailure) {
      throw new Error(turnFailure);
    }
    if (terminal.kind === "ok" && !terminatedByTool) {
      stage = "read_items";
      const items = await client.items(remoteSessionId, rootTurn.id, controller.signal);
      assertCurrent();
      const text = selectAgentsApiReplyText(items);
      stage = "collect_outputs";
      outputMedia = await collectOutputs(
        client,
        remoteSessionId,
        rootTurn.id,
        assertCurrent,
        controller.signal,
      );
      if (rootTurn.usage) {
        usage = updateAgentsApiUsage(usage, rootTurn.usage);
        params.hostCapabilities.reportOutputTokens?.(usage.output);
        calculateCost(params.model, usage);
      }
      if (text) {
        stage = "commit_reply";
        lastAssistant = await commitAgentsApiAssistant(
          params,
          sessionTarget,
          remoteSessionId,
          rootTurn.id,
          text,
          usage,
          assertCurrent,
        );
        await params.onAssistantMessageStart?.();
      }
      assertCurrent();
      emitAssistantSnapshot(`agentsapi:${remoteSessionId}:${rootTurn.id}:reply`, text);
      if (text) {
        await params.onPartialReply?.({ text });
        assertCurrent();
      }
    }
  } catch (error) {
    if (!stopped || timedOut) {
      embeddedAgentLog.warn("Agents API attempt failed", {
        error: error instanceof Error ? error.stack : String(error),
        cause:
          error instanceof Error && error.cause instanceof Error ? error.cause.stack : undefined,
        timedOut,
        timeoutMs: params.timeoutMs,
        stage,
        admittedMessageCount,
        observedInputCount: observedInputItems.size,
        latestInputTurnId,
        terminalTurnId: rootTurn?.id,
      });
    }
    if (!stopped && submitted && !sessionSettled) {
      stop(false);
    }
    terminal = timedOut
      ? { kind: "timeout", phase: "prompt", source: "runtime", aborted: true }
      : params.abortSignal?.aborted
        ? { kind: "aborted", source: "external" }
        : interrupted
          ? { kind: "aborted", source: "runtime" }
          : { kind: "failed", source: "prompt", error };
  } finally {
    clearTimeout(timer);
    params.abortSignal?.removeEventListener("abort", onAbort);
    try {
      await cancellation;
    } catch (error) {
      terminal = { kind: "failed", source: "prompt", error };
    }
    stopped = true;
    controller.abort();
    for (const cleanup of toolCleanups.toReversed()) {
      try {
        await cleanup("Agents API attempt settled");
      } catch (error) {
        embeddedAgentLog.warn("Agents API tool cleanup failed", { error });
      }
    }
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
  }
  const assistantTexts =
    lastAssistant?.content.filter((part) => part.type === "text").map((part) => part.text) ?? [];
  return {
    terminal,
    sessionIdUsed: params.sessionId,
    sessionFileUsed: params.sessionFile,
    agentHarnessId: "agentsapi",
    messagesSnapshot: SessionManager.open(sessionTarget, params.workspaceDir).buildSessionContext()
      .messages,
    assistantTexts,
    lastAssistant,
    currentAttemptAssistant: lastAssistant,
    currentAttemptCompletedAssistant: lastAssistant,
    assistantTranscriptOwned: Boolean(lastAssistant),
    assistantTranscriptIdempotencyKey:
      lastAssistant && rootTurn ? `agentsapi:${remoteSessionId}:${rootTurn.id}` : undefined,
    toolMetas: toolSurface?.toolMetas ?? [],
    lastToolError: toolSurface?.lastToolError,
    ...toolSurface?.runtimeFacts,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    ...toolSurface?.delivery,
    ...(outputMedia && {
      hostOwnedToolMediaUrls: outputMedia.hostOwnedToolMediaUrls,
      toolMediaUrls: [
        ...new Set([...(toolSurface?.delivery.toolMediaUrls ?? []), ...outputMedia.toolMediaUrls]),
      ],
      // A shared trust flag must not promote unrelated plugin media merely
      // because this turn also produced a verified hosted artifact.
      toolTrustedLocalMedia:
        outputMedia.toolMediaUrls.length && !toolSurface?.delivery.toolMediaUrls?.length
          ? true
          : toolSurface?.delivery.toolTrustedLocalMedia,
    }),
    cloudCodeAssistFormatError: false,
    attemptUsage: usage,
    // Hosted commands are opaque, so admitted work is unsafe to replay.
    // Core may still continue the existing session's transcript after a transient failure.
    replayMetadata: { hadPotentialSideEffects: submitted, replaySafe: !submitted },
    itemLifecycle: {
      startedCount: startedToolCount,
      completedCount: completedToolCount,
      activeCount: Math.max(0, startedToolCount - completedToolCount),
    },
  };
}
