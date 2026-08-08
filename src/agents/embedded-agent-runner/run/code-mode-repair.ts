import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
} from "../../code-mode-control-tools.js";
import { CODE_MODE_REPAIR_EVIDENCE } from "../../code-mode-repair-evidence.js";
import type {
  AfterToolCallResult,
  AfterToolOutcomeContext,
  Agent,
  AgentToolResult,
} from "../../runtime/index.js";

type CodeModeFailurePhase = "input" | "guest" | "bridge" | "host";

type CodeModeFailure = {
  code: string;
  error: string;
  failurePhase: CodeModeFailurePhase;
  bridgeDispatchStarted: boolean;
  repairEvidence?: true;
  details: Record<string, unknown>;
};

type RepairState = "ready" | "offered" | "consumed";
type RepairClaim = {
  assistantMessage: AfterToolOutcomeContext["assistantMessage"];
  acceptedToolCallId?: string;
  rejectionReason?: string;
};

const REPAIR_BATCH_REJECTION =
  "The Code Mode repair turn must contain exactly one exec call and no other tool calls.";
const REPAIR_SIDE_EFFECT_REJECTION =
  "The Code Mode repair opportunity was revoked because another tool started potentially side-effectful execution.";

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((entry): entry is Extract<(typeof result.content)[number], { type: "text" }> => {
      return entry.type === "text";
    })
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function normalizeFailurePhase(
  value: unknown,
  fallback: CodeModeFailurePhase,
): CodeModeFailurePhase {
  return value === "input" || value === "guest" || value === "bridge" || value === "host"
    ? value
    : fallback;
}

function codeModeFailureFromOutcome(context: AfterToolOutcomeContext): CodeModeFailure | undefined {
  const details = isRecord(context.result.details) ? context.result.details : {};
  if (details.status === "failed") {
    const bridgeDispatchStarted = details.bridgeDispatchStarted === true;
    return {
      code: typeof details.code === "string" ? details.code : "internal_error",
      error:
        typeof details.error === "string"
          ? details.error
          : resultText(context.result) || "code mode execution failed",
      failurePhase: normalizeFailurePhase(
        details.failurePhase,
        bridgeDispatchStarted ? "bridge" : context.executionStarted ? "guest" : "input",
      ),
      bridgeDispatchStarted,
      ...(Reflect.get(details, CODE_MODE_REPAIR_EVIDENCE) ? { repairEvidence: true as const } : {}),
      details,
    };
  }
  if (!context.isError) {
    return undefined;
  }
  const argumentValidation =
    !context.executionStarted && context.errorKind === "argument-validation";
  return {
    code: argumentValidation ? "invalid_input" : "internal_error",
    error: resultText(context.result) || "code mode execution failed",
    failurePhase: argumentValidation ? "input" : "host",
    bridgeDispatchStarted: context.executionStarted,
    details,
  };
}

function isSyntheticToolLoopRecoveryOutcome(context: AfterToolOutcomeContext): boolean {
  if (context.executionStarted || !context.isError) {
    return false;
  }
  const details = isRecord(context.result.details) ? context.result.details : {};
  const intervention = isRecord(details.intervention) ? details.intervention : {};
  if (
    details.status !== "blocked" ||
    details.deniedReason !== "tool-loop" ||
    intervention.kind !== "critical-tool-loop" ||
    typeof intervention.toolCallId !== "string" ||
    typeof intervention.toolName !== "string"
  ) {
    return false;
  }
  const toolCalls = context.assistantMessage.content.filter((entry) => entry.type === "toolCall");
  const currentCallMatches = toolCalls.some(
    (entry) => entry.id === context.toolCall.id && entry.name === context.toolCall.name,
  );
  const interventionMatches = toolCalls.some(
    (entry) => entry.id === intervention.toolCallId && entry.name === intervention.toolName,
  );
  return currentCallMatches && interventionMatches;
}

function renderFailure(params: {
  failure: CodeModeFailure;
  allowed: boolean;
  remainingAttempts: number;
  reason: string;
  terminate: boolean;
}): AfterToolCallResult {
  const repair = {
    allowed: params.allowed,
    remainingAttempts: params.remainingAttempts,
    reason: params.reason,
  };
  const modelPayload = {
    status: "failed",
    code: params.failure.code,
    error: params.failure.error,
    failurePhase: params.failure.failurePhase,
    bridgeDispatchStarted: params.failure.bridgeDispatchStarted,
    ...(Object.hasOwn(params.failure.details, "output")
      ? { output: params.failure.details.output }
      : {}),
    repair,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(modelPayload) }],
    details: {
      ...params.failure.details,
      status: "failed",
      code: params.failure.code,
      error: params.failure.error,
      failurePhase: params.failure.failurePhase,
      bridgeDispatchStarted: params.failure.bridgeDispatchStarted,
      repair,
    },
    isError: true,
    terminate: params.terminate,
  };
}

function mergePriorOutcome(
  context: AfterToolOutcomeContext,
  prior: AfterToolCallResult | undefined,
): AfterToolOutcomeContext {
  if (!prior) {
    return context;
  }
  return {
    ...context,
    result: {
      ...context.result,
      content: prior.content ?? context.result.content,
      details: prior.details ?? context.result.details,
      terminate:
        context.result.terminate === true || prior.terminate === true
          ? true
          : (prior.terminate ?? context.result.terminate),
    },
    isError: prior.isError ?? context.isError,
  };
}

function hookFailure(
  context: AfterToolOutcomeContext,
  original: CodeModeFailure | undefined,
  error: unknown,
): CodeModeFailure {
  return {
    code: "internal_error",
    error: `Code Mode outcome hook failed: ${error instanceof Error ? error.message : String(error)}`,
    failurePhase: original?.bridgeDispatchStarted
      ? "bridge"
      : context.executionStarted
        ? "host"
        : "input",
    bridgeDispatchStarted: original?.bridgeDispatchStarted ?? context.executionStarted,
    details: original?.details ?? {},
  };
}

function claimRepairTurn(
  assistantMessage: AfterToolOutcomeContext["assistantMessage"],
  hasPotentialSideEffects: () => boolean,
): RepairClaim {
  const toolCalls = assistantMessage.content.filter((entry) => entry.type === "toolCall");
  const singletonExec = toolCalls.length === 1 && toolCalls[0]?.name === CODE_MODE_EXEC_TOOL_NAME;
  const accepted = singletonExec && !hasPotentialSideEffects();
  return {
    assistantMessage,
    ...(accepted && toolCalls[0] ? { acceptedToolCallId: toolCalls[0].id } : {}),
    ...(!accepted
      ? {
          rejectionReason: singletonExec ? REPAIR_SIDE_EFFECT_REJECTION : REPAIR_BATCH_REJECTION,
        }
      : {}),
  };
}

function renderRepairBatchRejection(
  prior?: AfterToolCallResult,
  reason = REPAIR_BATCH_REJECTION,
): AfterToolCallResult {
  const details = isRecord(prior?.details) ? prior.details : {};
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "blocked",
          code: "invalid_input",
          error: reason,
          repair: { allowed: false, remainingAttempts: 0, reason },
        }),
      },
    ],
    details: {
      ...details,
      status: "blocked",
      code: "invalid_input",
      error: reason,
      deniedReason: "code-mode-repair",
      repair: { allowed: false, remainingAttempts: 0, reason },
    },
    isError: true,
    terminate: true,
  };
}

/** Installs one bounded, side-effect-aware Code Mode repair opportunity. */
export function installCodeModeRepairHook(params: {
  agent: Agent;
  hasPotentialSideEffects: () => boolean;
}): void {
  const previousBeforeToolCall = params.agent.beforeToolCall?.bind(params.agent);
  const previousAfterToolOutcome = params.agent.afterToolOutcome?.bind(params.agent);
  let repairState: RepairState = "ready";
  let repairOfferedBy: AfterToolOutcomeContext["assistantMessage"] | undefined;
  let repairClaim: RepairClaim | undefined;

  const claimNewRepairTurn = (
    assistantMessage: AfterToolOutcomeContext["assistantMessage"],
  ): RepairClaim => {
    repairState = "consumed";
    repairClaim = claimRepairTurn(assistantMessage, params.hasPotentialSideEffects);
    return repairClaim;
  };

  params.agent.beforeToolCall = async (context, signal) => {
    const prior = await previousBeforeToolCall?.(context, signal);
    if (prior?.block) {
      return prior;
    }
    const claim =
      repairState === "offered" && context.assistantMessage !== repairOfferedBy
        ? claimNewRepairTurn(context.assistantMessage)
        : repairClaim;
    if (
      claim?.assistantMessage === context.assistantMessage &&
      claim.acceptedToolCallId !== context.toolCall.id
    ) {
      return { block: true, reason: claim.rejectionReason ?? REPAIR_BATCH_REJECTION };
    }
    return prior;
  };

  params.agent.afterToolOutcome = async (context, signal) => {
    const syntheticToolLoopRecovery = isSyntheticToolLoopRecoveryOutcome(context);
    const codeModeTool =
      context.toolCall.name === CODE_MODE_EXEC_TOOL_NAME ||
      context.toolCall.name === CODE_MODE_WAIT_TOOL_NAME;
    const originalFailure = codeModeTool ? codeModeFailureFromOutcome(context) : undefined;
    let prior: AfterToolCallResult | undefined;
    try {
      prior = await previousAfterToolOutcome?.(context, signal);
    } catch (error) {
      if (syntheticToolLoopRecovery) {
        return renderFailure({
          failure: hookFailure(context, originalFailure, error),
          allowed: false,
          remainingAttempts: 0,
          reason: "A Code Mode outcome hook failed, so retry safety cannot be established.",
          terminate: true,
        });
      }
      const claim =
        repairState === "offered" && context.assistantMessage !== repairOfferedBy
          ? claimNewRepairTurn(context.assistantMessage)
          : repairClaim;
      if (claim?.assistantMessage === context.assistantMessage && !claim.acceptedToolCallId) {
        return renderRepairBatchRejection(undefined, claim.rejectionReason);
      }
      if (!codeModeTool) {
        throw error;
      }
      return renderFailure({
        failure: hookFailure(context, originalFailure, error),
        allowed: false,
        remainingAttempts: 0,
        reason: "A Code Mode outcome hook failed, so retry safety cannot be established.",
        terminate: true,
      });
    }
    // Agent core owns this synthetic recovery turn. Keep Code Mode's repair
    // offered so the next genuine corrective assistant turn can claim it.
    if (syntheticToolLoopRecovery) {
      return prior;
    }
    const claim =
      repairState === "offered" && context.assistantMessage !== repairOfferedBy
        ? claimNewRepairTurn(context.assistantMessage)
        : repairClaim;
    if (claim?.assistantMessage === context.assistantMessage && !claim.acceptedToolCallId) {
      return renderRepairBatchRejection(prior, claim.rejectionReason);
    }
    if (!codeModeTool) {
      return prior;
    }
    const effective = mergePriorOutcome(context, prior);

    const failure = codeModeFailureFromOutcome(effective) ?? originalFailure;
    if (!failure) {
      if (context.result.terminate === true) {
        return { ...prior, terminate: true };
      }
      return prior;
    }

    if (context.result.terminate === true || effective.result.terminate === true) {
      repairState = "consumed";
      return renderFailure({
        failure,
        allowed: false,
        remainingAttempts: 0,
        reason: "The finalized Code Mode outcome is terminal and cannot be repaired.",
        terminate: true,
      });
    }

    if (effective.toolCall.name === CODE_MODE_WAIT_TOOL_NAME) {
      repairState = "consumed";
      return renderFailure({
        failure,
        allowed: false,
        remainingAttempts: 0,
        reason: "Code Mode wait failures are not repairable in the current turn.",
        terminate: true,
      });
    }

    const repairable =
      originalFailure?.repairEvidence === true && !params.hasPotentialSideEffects();
    if (repairState === "offered" && effective.assistantMessage === repairOfferedBy && repairable) {
      return renderFailure({
        failure,
        allowed: true,
        remainingAttempts: 1,
        reason:
          "Retry exec once with corrected JavaScript or TypeScript. Do not repeat unchanged input.",
        terminate: false,
      });
    }

    if (repairState === "offered" || repairState === "consumed") {
      repairState = "consumed";
      return renderFailure({
        failure,
        allowed: false,
        remainingAttempts: 0,
        reason: "The single Code Mode repair attempt is exhausted.",
        terminate: true,
      });
    }

    if (!repairable) {
      repairState = "consumed";
      return renderFailure({
        failure,
        allowed: false,
        remainingAttempts: 0,
        reason: "This Code Mode failure is not safely repairable in the current turn.",
        terminate: true,
      });
    }

    repairState = "offered";
    repairOfferedBy = effective.assistantMessage;
    return renderFailure({
      failure,
      allowed: true,
      remainingAttempts: 1,
      reason:
        "Retry exec once with corrected JavaScript or TypeScript. Do not repeat unchanged input.",
      terminate: false,
    });
  };
}
