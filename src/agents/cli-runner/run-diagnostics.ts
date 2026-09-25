import { getRuntimeConfig } from "../../config/config.js";
import {
  joinDiagnosticContent,
  truncateDiagnosticContent,
} from "../../infra/diagnostic-content.js";
/** Trusted run hierarchy for Claude Code CLI-backed agent turns. */
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticErrorMessage,
} from "../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticHarnessRunErrorEvent,
} from "../../infra/diagnostic-events.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../infra/diagnostic-llm-content.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import { isSignalTimeoutReason, isTimeoutError } from "../failover-error.js";
import { subscribeAgentCommentaryDiagnostics } from "../harness/commentary-diagnostics.js";
import type { RunCliAgentParams } from "./types.js";

type ClaudeCliRunPhase = DiagnosticHarnessRunErrorEvent["phase"];

export type ClaudeCliRunDiagnosticLifecycle = {
  setPhase: (phase: ClaudeCliRunPhase) => void;
  /**
   * Publishes the execution owner and effective config resolved by preparation.
   * Run/harness events emitted after this call attribute to that owner so the
   * spans agree with model-call spans built from the prepared params; events
   * emitted before it carry the caller's requester identity, and an absent
   * owner keeps that admission-time identity. Commentary capture uses this
   * prepared config rather than a potentially absent admission-time config.
   */
  setExecutionContext: (context: Pick<RunCliAgentParams, "agentId" | "config">) => void;
  /**
   * Publishes the prepared turn prompt and final response text for
   * captureContent-gated span attributes. Called after preparation resolves
   * the exact prompt and after the run produces its visible reply payloads.
   */
  publishCapturedContent: (content: { userPrompt?: string; finalResponse?: string }) => void;
  publishResultContent: (result: EmbeddedAgentRunResult) => void;
};

type ClaudeCliRunDiagnosticParams = Pick<
  RunCliAgentParams,
  | "abortSignal"
  | "agentId"
  | "messageChannel"
  | "messageProvider"
  | "model"
  | "modelProvider"
  | "runId"
  | "sessionId"
  | "sessionKey"
  | "trigger"
>;

function diagnosticBase(params: ClaudeCliRunDiagnosticParams, trace: DiagnosticTraceContext) {
  const channel = params.messageChannel ?? params.messageProvider;
  return {
    runId: params.runId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    provider: params.modelProvider ?? "anthropic",
    ...(params.model ? { model: params.model } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(channel ? { channel } : {}),
    trace,
  };
}

function resultRunOutcome(
  result: EmbeddedAgentRunResult,
): "completed" | "aborted" | "blocked" | "error" {
  if (result.meta.livenessState === "blocked") {
    return "blocked";
  }
  if (result.meta.aborted === true) {
    return "aborted";
  }
  if (result.meta.error) {
    return "error";
  }
  return "completed";
}

function errorHarnessOutcome(
  error: unknown,
  abortSignal: AbortSignal | undefined,
): "aborted" | "timed_out" | "error" {
  const failureKind = diagnosticErrorFailureKind(error);
  if (failureKind === "timeout") {
    return "timed_out";
  }
  if (failureKind === "aborted") {
    return abortSignal?.aborted && isSignalTimeoutReason(abortSignal.reason)
      ? "timed_out"
      : "aborted";
  }
  if (abortSignal?.aborted === true) {
    return isSignalTimeoutReason(abortSignal.reason) ? "timed_out" : "aborted";
  }
  if (isTimeoutError(error)) {
    return "timed_out";
  }
  return "error";
}

/**
 * Wraps one OpenClaw Claude CLI turn in synthetic harness/run boundaries.
 * The child run scope makes every real Claude CLI model call nest beneath it.
 */
/**
 * Visible final-answer text for captureContent-gated span content. Mirrors
 * the reply-layer capture: reasoning and commentary lanes are excluded, and
 * messaging-tool sends are not part of the final answer.
 */
export function cliFinalResponseText(
  payloads: EmbeddedAgentRunResult["payloads"],
): string | undefined {
  return joinDiagnosticContent(
    (payloads ?? [])
      .filter(
        (payload) =>
          payload.isReasoning !== true &&
          payload.isCommentary !== true &&
          typeof payload.text === "string" &&
          payload.text.trim() !== "",
      )
      .map((payload) => (typeof payload.text === "string" ? payload.text : "")),
  );
}

export async function runClaudeCliAgentTurnWithDiagnostics(
  params: ClaudeCliRunDiagnosticParams,
  run: (lifecycle: ClaudeCliRunDiagnosticLifecycle) => Promise<EmbeddedAgentRunResult>,
): Promise<EmbeddedAgentRunResult> {
  const harnessTrace = freezeDiagnosticTraceContext(createDiagnosticTraceContextFromActiveScope());
  const runTrace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(harnessTrace));
  const harnessBase = {
    ...diagnosticBase(params, harnessTrace),
    harnessId: "claude-cli",
  };
  const runBase = diagnosticBase(params, runTrace);
  const startedAt = Date.now();
  let phase: ClaudeCliRunPhase = "prepare";
  let unsubscribeCommentary: (() => void) | undefined;
  const contentCapturePolicy = resolveDiagnosticModelContentCapturePolicy(getRuntimeConfig());
  let capturedContent: { userPrompt?: string; finalResponse?: string } | undefined;
  // True when publication produced at least one gated, non-empty field; an empty
  // publication (policy off, or all fields filtered) attaches no private data.
  const hasCapturedContent = () =>
    capturedContent !== undefined && Object.keys(capturedContent).length > 0;
  const lifecycle: ClaudeCliRunDiagnosticLifecycle = {
    setPhase: (nextPhase) => {
      phase = nextPhase;
    },
    setExecutionContext: ({ agentId, config }) => {
      // The caller's agentId can name a distinct runtime-policy requester;
      // preparation is the authoritative producer of the execution-owner fact,
      // so once it publishes the resolved owner every later run/harness event
      // must report it instead of the admission-time requester.
      if (agentId) {
        harnessBase.agentId = agentId;
        runBase.agentId = agentId;
      }
      unsubscribeCommentary?.();
      unsubscribeCommentary = subscribeAgentCommentaryDiagnostics(config, harnessBase);
    },
    publishResultContent: (result) => {
      if (!contentCapturePolicy.outputMessages) {
        return;
      }
      lifecycle.publishCapturedContent({ finalResponse: cliFinalResponseText(result.payloads) });
    },
    publishCapturedContent: (content) => {
      // Content is stored, gated, and bounded once at publication; completed
      // events attach it as private data and the exporter re-checks the policy
      // before placing anything on a span. Publications merge rather than
      // replace: the prompt arrives after preparation and the response after
      // settlement, so both must survive to the completion events.
      capturedContent = {
        ...capturedContent,
        ...(content.userPrompt !== undefined && contentCapturePolicy.inputMessages
          ? { userPrompt: truncateDiagnosticContent(content.userPrompt) }
          : {}),
        ...(content.finalResponse !== undefined && contentCapturePolicy.outputMessages
          ? { finalResponse: truncateDiagnosticContent(content.finalResponse) }
          : {}),
      };
    },
  };

  emitTrustedDiagnosticEvent({
    type: "harness.run.started",
    ...harnessBase,
  });
  emitTrustedDiagnosticEvent({
    type: "run.started",
    ...runBase,
  });

  try {
    const result = await runWithDiagnosticTraceContext(runTrace, () => run(lifecycle));
    const runOutcome = resultRunOutcome(result);
    const resultErrorMessage = result.meta.error?.message;
    const runErrorMessage = runOutcome === "error" ? resultErrorMessage : undefined;
    const runCompletedPrivateData =
      runErrorMessage || hasCapturedContent()
        ? {
            ...(runErrorMessage ? { errorMessage: runErrorMessage } : {}),
            ...(hasCapturedContent() ? { messageContent: capturedContent } : {}),
          }
        : undefined;
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        ...runBase,
        durationMs: Date.now() - startedAt,
        outcome: runOutcome,
        ...(runOutcome === "blocked" ? { blockedBy: "before_agent_run" } : {}),
        ...(runOutcome === "error" && result.meta.error
          ? { errorCategory: result.meta.error.kind }
          : {}),
      },
      runCompletedPrivateData,
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "harness.run.completed",
        ...harnessBase,
        durationMs: Date.now() - startedAt,
        outcome:
          result.meta.timeoutPhase !== undefined
            ? "timed_out"
            : runOutcome === "aborted"
              ? "aborted"
              : runOutcome === "completed"
                ? "completed"
                : "error",
        ...(typeof result.meta.yielded === "boolean" ? { yieldDetected: result.meta.yielded } : {}),
      },
      // The harness span is the turn's root; it carries the same gated content
      // the run span gets, keyed as harnessContent for the harness recorder.
      (resultErrorMessage && (runOutcome === "error" || runOutcome === "blocked")) ||
        hasCapturedContent()
        ? {
            ...(resultErrorMessage && (runOutcome === "error" || runOutcome === "blocked")
              ? { errorMessage: resultErrorMessage }
              : {}),
            ...(hasCapturedContent() ? { harnessContent: capturedContent } : {}),
          }
        : undefined,
    );
    return result.diagnosticTrace ? result : { ...result, diagnosticTrace: harnessTrace };
  } catch (error) {
    const errorMessage = diagnosticErrorMessage(error);
    const harnessOutcome = errorHarnessOutcome(error, params.abortSignal);
    // Failed, timed-out, and aborted turns keep their already-captured prompt:
    // it is precisely what operators need for diagnosis, and startup events
    // cannot carry it because CLI prompt publication happens after preparation.
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        ...runBase,
        durationMs: Date.now() - startedAt,
        outcome: harnessOutcome === "error" ? "error" : "aborted",
        ...(harnessOutcome === "error" ? { errorCategory: diagnosticErrorCategory(error) } : {}),
      },
      {
        ...(errorMessage ? { errorMessage } : {}),
        ...(hasCapturedContent() ? { messageContent: capturedContent } : {}),
      },
    );
    if (harnessOutcome === "error") {
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "harness.run.error",
          ...harnessBase,
          durationMs: Date.now() - startedAt,
          phase,
          errorCategory: diagnosticErrorCategory(error),
        },
        {
          ...(errorMessage ? { errorMessage } : {}),
          ...(hasCapturedContent() ? { harnessContent: capturedContent } : {}),
        },
      );
    } else {
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "harness.run.completed",
          ...harnessBase,
          durationMs: Date.now() - startedAt,
          outcome: harnessOutcome,
        },
        hasCapturedContent() ? { harnessContent: capturedContent } : undefined,
      );
    }
    throw error;
  } finally {
    unsubscribeCommentary?.();
  }
}
