// Subscription-auth callers opt into CLI latency to avoid metered direct-API passthrough.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { onAgentEventForRun } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolvePreparedRunAdmission } from "../admitted-run-context.js";
import { stripOpenClawMcpToolPrefix } from "../cli-runner/tool-policy.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import { isToolResultError } from "../tool-result-error.js";
import { resolveEmbeddedCliBackendDispatchEligibility } from "./cli-backend-dispatch-eligibility.js";
import { createCliDispatchTranscriptRecorder } from "./cli-backend-dispatch-transcript.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const log = createSubsystemLogger("agents/embedded-cli-dispatch");

type CliBackendDispatchParams = RunEmbeddedAgentInternalParams & {
  sessionTarget: SessionTranscriptRuntimeTarget;
};

export async function runEmbeddedAgentViaCliBackendIfEligible(
  params: CliBackendDispatchParams,
): Promise<EmbeddedAgentRunResult | undefined> {
  if (params.cliBackendDispatch !== "subscription-auth") {
    return undefined;
  }
  // The one-shot bridge cannot carry authenticated source-channel delivery
  // context; private source replies must stay with their embedded owner.
  if (params.sourceReplyDeliveryMode === "message_tool_only") {
    return undefined;
  }
  // The CLI runner needs the caller-owned transcript path; runs without one
  // stay on the passthrough where session targets are resolved internally.
  const sessionFile = params.sessionFile?.trim();
  if (!sessionFile) {
    return undefined;
  }
  // The CLI bridge supports only a non-empty named allowlist bounded by its loopback grant.
  // Other policies stay on the embedded path so dispatch cannot widen tool access (#57326).
  if (params.disableTools || params.modelRun) {
    return undefined;
  }
  if (!params.toolsAllow || params.toolsAllow.length === 0) {
    return undefined;
  }
  const names = params.toolsAllow.map(normalizeToolPolicyName);
  if (names.some((name) => !name || name.includes("*"))) {
    return undefined;
  }
  const toolsAllow = [...new Set(names)];
  const eligibility = resolveEmbeddedCliBackendDispatchEligibility(params);
  if (!eligibility) {
    return undefined;
  }
  const { runCliAgent } = await import("../cli-runner.runtime.js");
  const admittedRunContext = await resolvePreparedRunAdmission({
    runId: params.runId,
    runtimeKind: "embedded",
    admittedRunContext: params.admittedRunContext,
    preparedRunAdmission: params.preparedRunAdmission,
  });
  // Only the granted loopback tools are selectable; native tools, message sends,
  // and user/plugin MCP servers remain unavailable.
  const cliToolAvailability = {
    native: [] as [],
    openClaw: toolsAllow,
  };
  const onAgentToolResult = params.onAgentToolResult;
  const { storePath, expectedLifecycleRevision, expectedWriterRunId } = params.sessionTarget;
  // Durable turns mirror CLI output for transcript readers and timeout salvage.
  // Detached runs may borrow the identity without owning its transcript.
  const transcript =
    params.sessionManager || params.sessionPersistence === "detached"
      ? undefined
      : createCliDispatchTranscriptRecorder({
          ...params,
          storePath,
          sessionFile,
          provider: eligibility.provider,
          cwd: params.cwd ?? params.workspaceDir,
          expectedLifecycleRevision,
          expectedWriterRunId,
        });
  // Match native embedded tool names and soft-error signals after CLI transport decoding.
  const unsubscribe = onAgentEventForRun(params.runId, (evt) => {
    if (evt.stream === "assistant" && typeof evt.data.text === "string") {
      transcript?.noteAssistantText(evt.data.text);
      return;
    }
    if (evt.stream !== "tool") {
      return;
    }
    const phase = evt.data.phase;
    if (phase !== "start" && phase !== "result") {
      return;
    }
    const rawName = typeof evt.data.name === "string" ? evt.data.name : "";
    if (!rawName) {
      return;
    }
    const toolName = normalizeToolPolicyName(stripOpenClawMcpToolPrefix(rawName));
    const toolCallId = typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : undefined;
    if (phase === "start") {
      transcript?.noteToolEvent({
        phase,
        toolName,
        toolCallId,
        args: isRecord(evt.data.args) ? evt.data.args : undefined,
      });
      return;
    }
    const isError = evt.data.isError === true || isToolResultError(evt.data.result);
    const resultContentSource = evt.data.resultContentSource === "network" ? "network" : undefined;
    transcript?.noteToolEvent({
      phase,
      toolName,
      toolCallId,
      result: evt.data.result,
      isError,
      ...(resultContentSource ? { resultContentSource } : {}),
    });
    onAgentToolResult?.({
      toolName,
      result: evt.data.result,
      isError,
    });
  });
  // Timeout salvage reads before the killed CLI child settles; flush on abort.
  const flushOnAbort = () => transcript?.flushAssistantSnapshot();
  params.abortSignal?.addEventListener("abort", flushOnAbort, { once: true });
  // Match native post-admission lifecycle and watchdog activation.
  log.info(
    `dispatching embedded run through CLI backend: runId=${params.runId} provider=${eligibility.provider} model=${params.model ?? ""}`,
  );
  let finalAssistantText: string | undefined;
  try {
    await params.onExecutionStarted?.(
      params.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: params.lifecycleGeneration }
        : undefined,
    );
    const result = await runCliAgent({
      admittedRunContext,
      sessionManager: params.sessionManager,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionTarget: params.sessionTarget,
      expectedLifecycleRevision,
      expectedWriterRunId,
      chatType: params.chatType,
      agentId: params.agentId,
      storePath,
      trigger: params.trigger,
      sessionFile,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.config,
      prompt: params.prompt,
      imagePrompt: params.prompt,
      images: params.images,
      imageOrder: params.imageOrder,
      media: params.media,
      provider: eligibility.provider,
      model: params.model,
      ...(params.requestedRouteResolution === "resolved" && params.provider && params.model
        ? { requesterModel: { provider: params.provider, model: params.model } }
        : {}),
      authProfileId: params.authProfileId,
      modelHasVision: params.modelHasVision,
      contextWindow: params.contextWindow,
      thinkLevel: params.thinkLevel,
      fastMode: params.fastMode,
      fastModeStartedAtMs: params.fastModeStartedAtMs,
      fastModeAutoOnSeconds: params.fastModeAutoOnSeconds,
      timeoutMs: params.timeoutMs,
      runTimeoutOverrideMs: params.runTimeoutOverrideMs ?? params.timeoutMs,
      runId: params.runId,
      lifecycleGeneration: params.lifecycleGeneration,
      lane: params.lane,
      extraSystemPrompt: params.extraSystemPrompt,
      messageChannel: params.messageChannel,
      messageProvider: params.messageProvider,
      bootstrapContextMode: params.bootstrapContextMode,
      bootstrapContextRunKind: params.bootstrapContextRunKind,
      abortSignal: params.abortSignal,
      onBlockReply: params.onBlockReply,
      onPartialReply: params.onPartialReply,
      onExecutionPhase: params.onExecutionPhase,
      cliToolAvailability,
      // One-shot helper run: fresh CLI process, no warm live session left
      // behind, and no implicit message sends without an explicit target.
      disableCliLiveSession: true,
      cleanupCliLiveSessionOnRunEnd: true,
      runtimeFactsInTurn: true,
      requireExplicitMessageTarget: true,
      cleanupBundleMcpOnRunEnd: params.cleanupBundleMcpOnRunEnd,
    });
    finalAssistantText = result.payloads?.find(
      (payload) => payload.isReasoning !== true && typeof payload.text === "string",
    )?.text;
    // A one-shot dispatch has no session owner for a returned CLI binding.
    const agentMeta = result.meta.agentMeta;
    if (!agentMeta?.cliSessionBinding && agentMeta?.clearCliSessionBinding !== true) {
      return result;
    }
    return {
      ...result,
      meta: {
        ...result.meta,
        agentMeta: {
          ...agentMeta,
          cliSessionBinding: undefined,
          clearCliSessionBinding: undefined,
        },
      },
    };
  } finally {
    params.abortSignal?.removeEventListener("abort", flushOnAbort);
    unsubscribe();
    // Flush before the promise settles: timeout salvage reads the session
    // file as soon as the caller observes the rejection.
    await transcript?.finalize(finalAssistantText);
  }
}
