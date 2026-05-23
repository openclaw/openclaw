export const TELEGRAM_LONG_TURN_SOFT_DEADLINE_MS = 30_000;

export type TelegramLongTurnDeliveryState = {
  runId: string;
  agentId: string;
  accountId: string;
  sessionKey?: string;
  chatId: string;
  threadId?: number;
  markDeferralPending: () => void;
  markDeferred: () => void;
  isDeferred: () => boolean;
  onDeferralPending: (listener: () => void) => () => void;
  waitForDeferralNotice: () => Promise<void>;
  markFinalDeliveryStarted: () => void;
  hasFinalDeliveryStarted: () => boolean;
  setCanSendDeferralNotice: (check: () => boolean) => void;
  canSendDeferralNotice: () => boolean;
};

type TelegramLongTurnDeliveryStateParams = {
  runId: string;
  agentId: string;
  accountId: string;
  sessionKey?: string;
  chatId: string;
  threadId?: number;
};

export function createTelegramLongTurnDeliveryState(
  params: TelegramLongTurnDeliveryStateParams,
): TelegramLongTurnDeliveryState {
  let deferred = false;
  let deferralNoticePending = false;
  let finalDeliveryStarted = false;
  let canSendDeferralNotice = () => true;
  let resolveDeferralNotice: (() => void) | undefined;
  const deferralPendingListeners = new Set<() => void>();
  const deferralNoticeSettled = new Promise<void>((resolve) => {
    resolveDeferralNotice = resolve;
  });
  return {
    ...params,
    markDeferralPending: () => {
      deferred = true;
      deferralNoticePending = true;
      for (const listener of deferralPendingListeners) {
        listener();
      }
    },
    markDeferred: () => {
      deferred = true;
      deferralNoticePending = false;
      resolveDeferralNotice?.();
    },
    isDeferred: () => deferred,
    onDeferralPending: (listener) => {
      if (deferred) {
        listener();
        return () => {};
      }
      deferralPendingListeners.add(listener);
      return () => {
        deferralPendingListeners.delete(listener);
      };
    },
    waitForDeferralNotice: async () => {
      if (deferralNoticePending) {
        await deferralNoticeSettled;
      }
    },
    markFinalDeliveryStarted: () => {
      finalDeliveryStarted = true;
    },
    hasFinalDeliveryStarted: () => finalDeliveryStarted,
    setCanSendDeferralNotice: (check) => {
      canSendDeferralNotice = check;
    },
    canSendDeferralNotice: () => canSendDeferralNotice(),
  };
}

export function buildTelegramLongTurnDeferralText(params: { runId: string }): string {
  return `Still working on this. I will reply here when the run completes.\n\nRun: ${params.runId}`;
}

export function buildTelegramDeferredRunFailureText(params: {
  runId: string;
  agentId: string;
  sessionKey?: string;
  target: string;
}): string {
  return buildDeferredRunSummary({
    title: "The deferred run did not complete successfully.",
    runId: params.runId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    target: params.target,
  });
}

export function buildTelegramDeferredRunEmptyResponseText(params: {
  runId: string;
  agentId: string;
  sessionKey?: string;
  target: string;
}): string {
  return buildDeferredRunSummary({
    title: "The deferred run finished, but no final response was delivered.",
    runId: params.runId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    target: params.target,
  });
}

export function buildTelegramDeferredRunSilentCompletionText(params: {
  runId: string;
  agentId: string;
  sessionKey?: string;
  target: string;
}): string {
  return buildDeferredRunSummary({
    title: "The deferred run completed without sending a visible reply.",
    runId: params.runId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    target: params.target,
  });
}

export function formatTelegramDeferredRunTarget(params: {
  chatId: string | number;
  threadId?: number;
}): string {
  return params.threadId == null
    ? `telegram:${params.chatId}`
    : `telegram:${params.chatId}/${params.threadId}`;
}

function buildDeferredRunSummary(params: {
  title: string;
  runId: string;
  agentId: string;
  sessionKey?: string;
  target: string;
}): string {
  const lines = [
    params.title,
    "",
    `Run: ${params.runId}`,
    `Agent: ${params.agentId}`,
    params.sessionKey ? `Session: ${params.sessionKey}` : undefined,
    `Target: ${params.target}`,
  ];
  return lines.filter((line): line is string => line != null).join("\n");
}
