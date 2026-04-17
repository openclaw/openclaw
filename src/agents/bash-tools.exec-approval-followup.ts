import {
  resolveExternalBestEffortDeliveryTarget,
  type ExternalBestEffortDeliveryTarget,
} from "../infra/outbound/best-effort-delivery.js";
import { sendMessage } from "../infra/outbound/message.js";
import { isCronSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isGatewayMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import {
  formatExecDeniedUserMessage,
  isExecDeniedResultText,
  parseExecApprovalResultText,
} from "./exec-approval-result.js";
import { sanitizeUserFacingText } from "./pi-embedded-helpers/errors.js";
import { callGatewayTool } from "./tools/gateway.js";

type ExecApprovalFollowupParams = {
  approvalId: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  resultText: string;
};

function buildExecDeniedFollowupPrompt(resultText: string): string {
  return [
    "An async command did not run.",
    "Do not run the command again.",
    "There is no new command output.",
    "If you can keep going without this command, continue silently.",
    "Otherwise send one short blocker message that says why it did not run and what the user should do next.",
    "Do not mention raw exec metadata or earlier output.",
    "",
    "Exact completion details:",
    resultText.trim(),
  ].join("\n");
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

export function buildExecApprovalFollowupPrompt(resultText: string): string {
  const trimmed = resultText.trim();
  if (isExecDeniedResultText(trimmed)) {
    return buildExecDeniedFollowupPrompt(trimmed);
  }
  return [
    "An async command the user already approved has finished.",
    "Do not run the command again.",
    "If you can keep going, continue silently and do not send a status-only reply.",
    "Reply only if the result changed user-visible state, unblocked the task, or you are actually blocked.",
    "Use one short plain-language result.",
    "Do not mention gateway ids, session ids, exit codes, raw stdout or stderr tails, duplicate completion notices, or other exec metadata.",
    "If it failed, give the cause and the next step.",
    "",
    "Exact completion details:",
    trimmed,
  ].join("\n");
}

function shouldSuppressExecDeniedFollowup(sessionKey: string | undefined): boolean {
  return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey);
}

function formatDirectExecApprovalFollowupText(
  resultText: string,
  opts: { allowDenied?: boolean } = {},
): string | null {
  const parsed = parseExecApprovalResultText(resultText);
  if (parsed.kind === "other" && !parsed.raw) {
    return null;
  }
  if (parsed.kind === "denied") {
    if (!opts.allowDenied) {
      return null;
    }
    const blocker = formatExecDeniedUserMessage(parsed.raw);
    return blocker ? `${blocker} Rerun the command if you want to try again.` : null;
  }

  if (parsed.kind === "finished") {
    const metadata = normalizeLowercaseStringOrEmpty(parsed.metadata);
    const succeeded = metadata.includes("code 0");
    const body = sanitizeUserFacingText(parsed.body, {
      errorContext: !succeeded,
    }).trim();

    if (succeeded) {
      return body || null;
    }

    return metadata.includes("signal")
      ? "Background command stopped unexpectedly. Rerun it in chat if you still need it."
      : "Background command failed. Rerun it in chat if you still need it.";
  }

  if (parsed.kind === "completed") {
    const body = sanitizeUserFacingText(parsed.body, { errorContext: true }).trim();
    return body || null;
  }

  return sanitizeUserFacingText(parsed.raw, { errorContext: true }).trim() || null;
}

function isSilentDirectExecApprovalFollowup(resultText: string): boolean {
  const parsed = parseExecApprovalResultText(resultText);
  if (parsed.kind === "finished") {
    const metadata = normalizeLowercaseStringOrEmpty(parsed.metadata);
    if (!metadata.includes("code 0")) {
      return false;
    }
    return sanitizeUserFacingText(parsed.body, { errorContext: false }).trim().length === 0;
  }
  if (parsed.kind === "completed") {
    return sanitizeUserFacingText(parsed.body, { errorContext: true }).trim().length === 0;
  }
  return false;
}

function canDirectSendDeniedFollowup(sessionError: unknown): boolean {
  return sessionError !== null;
}

function buildAgentFollowupArgs(params: {
  approvalId: string;
  sessionKey: string;
  resultText: string;
  deliveryTarget: ExternalBestEffortDeliveryTarget;
  sessionOnlyOriginChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
}) {
  const { deliveryTarget, sessionOnlyOriginChannel } = params;
  return {
    sessionKey: params.sessionKey,
    message: buildExecApprovalFollowupPrompt(params.resultText),
    deliver: deliveryTarget.deliver,
    ...(deliveryTarget.deliver ? { bestEffortDeliver: true as const } : {}),
    channel: deliveryTarget.deliver ? deliveryTarget.channel : sessionOnlyOriginChannel,
    to: deliveryTarget.deliver
      ? deliveryTarget.to
      : sessionOnlyOriginChannel
        ? params.turnSourceTo
        : undefined,
    accountId: deliveryTarget.deliver
      ? deliveryTarget.accountId
      : sessionOnlyOriginChannel
        ? params.turnSourceAccountId
        : undefined,
    threadId: deliveryTarget.deliver
      ? deliveryTarget.threadId
      : sessionOnlyOriginChannel
        ? params.turnSourceThreadId
        : undefined,
    idempotencyKey: `exec-approval-followup:${params.approvalId}`,
  };
}

async function sendDirectFollowupFallback(params: {
  approvalId: string;
  deliveryTarget: ExternalBestEffortDeliveryTarget;
  resultText: string;
  sessionError: unknown;
}): Promise<boolean> {
  const directText = formatDirectExecApprovalFollowupText(params.resultText, {
    allowDenied: canDirectSendDeniedFollowup(params.sessionError),
  });
  if (!params.deliveryTarget.deliver || !directText) {
    return false;
  }

  await sendMessage({
    channel: params.deliveryTarget.channel,
    to: params.deliveryTarget.to ?? "",
    accountId: params.deliveryTarget.accountId,
    threadId: params.deliveryTarget.threadId,
    content: directText,
    agentId: undefined,
    idempotencyKey: `exec-approval-followup:${params.approvalId}`,
  });
  return true;
}

export async function sendExecApprovalFollowup(
  params: ExecApprovalFollowupParams,
): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  const resultText = params.resultText.trim();
  if (!resultText) {
    return false;
  }
  const isDenied = isExecDeniedResultText(resultText);
  if (isDenied && shouldSuppressExecDeniedFollowup(sessionKey)) {
    return false;
  }

  const deliveryTarget = resolveExternalBestEffortDeliveryTarget({
    channel: params.turnSourceChannel,
    to: params.turnSourceTo,
    accountId: params.turnSourceAccountId,
    threadId: params.turnSourceThreadId,
  });
  const normalizedTurnSourceChannel = normalizeMessageChannel(params.turnSourceChannel);
  const sessionOnlyOriginChannel =
    normalizedTurnSourceChannel && isGatewayMessageChannel(normalizedTurnSourceChannel)
      ? normalizedTurnSourceChannel
      : undefined;

  let sessionError: unknown = null;

  if (sessionKey) {
    try {
      await callGatewayTool(
        "agent",
        { timeoutMs: 60_000 },
        buildAgentFollowupArgs({
          approvalId: params.approvalId,
          sessionKey,
          resultText,
          deliveryTarget,
          sessionOnlyOriginChannel,
          turnSourceTo: params.turnSourceTo,
          turnSourceAccountId: params.turnSourceAccountId,
          turnSourceThreadId: params.turnSourceThreadId,
        }),
        { expectFinal: true },
      );
      return true;
    } catch (err) {
      sessionError = err;
    }
  }

  if (
    await sendDirectFollowupFallback({
      approvalId: params.approvalId,
      deliveryTarget,
      resultText,
      sessionError,
    })
  ) {
    return true;
  }

  if (!sessionError && isSilentDirectExecApprovalFollowup(resultText)) {
    return true;
  }

  if (sessionError) {
    throw new Error(`Session followup failed: ${formatUnknownError(sessionError)}`);
  }
  if (isDenied) {
    return false;
  }
  throw new Error("Session key or deliverable origin route is required");
}
