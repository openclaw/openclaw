import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import type { QaGatewayChild } from "../../gateway-child.js";
import { readLiveQaChannelAccounts } from "../shared/live-channel-status.js";
import {
  type SlackChannelStatus,
  type SlackChannelReadinessMode,
  SLACK_QA_DEFAULT_READY_TIMEOUT_MS,
  SLACK_QA_READY_STABILITY_MS,
  type SlackAuthIdentity,
  type SlackObservedMessage,
  type SlackMessage,
  type SlackQaWebClient as WebClient,
} from "./slack-live.contracts.js";
import {
  listSlackMessages,
  listSlackThreadMessages,
  collectSlackBlockText,
  collectSlackActionValues,
  isSutSlackMessage,
} from "./slack-live.observations.js";

type SlackScenarioObservationContext = {
  channelId: string;
  matchText: string;
  observedMessages: SlackObservedMessage[];
  observationScenarioId: string;
  observationScenarioTitle: string;
  sentTs: string;
  sutIdentity: SlackAuthIdentity;
};

function recordSlackScenarioMessage(
  params: SlackScenarioObservationContext,
  message: SlackMessage,
  observedKeys?: Set<string>,
) {
  if (
    !message.ts ||
    message.ts === params.sentTs ||
    !isSutSlackMessage(message, params.sutIdentity)
  ) {
    return undefined;
  }
  const text = message.text ?? "";
  const matchedScenario = text.includes(params.matchText);
  const observedKey = `${params.channelId}:${message.ts}`;
  if (!observedKeys?.has(observedKey)) {
    observedKeys?.add(observedKey);
    params.observedMessages.push({
      actionValues: collectSlackActionValues(message.blocks),
      blockText: collectSlackBlockText(message.blocks),
      botId: message.bot_id,
      channelId: params.channelId,
      matchedScenario,
      scenarioId: params.observationScenarioId,
      scenarioTitle: params.observationScenarioTitle,
      text,
      threadTs: message.thread_ts,
      ts: message.ts,
      userId: message.user,
    });
  }
  return matchedScenario ? message : undefined;
}

function recordSlackScenarioMessages(
  params: SlackScenarioObservationContext,
  messages: SlackMessage[],
) {
  let matchedMessage: SlackMessage | undefined;
  for (const message of messages) {
    const match = recordSlackScenarioMessage(params, message);
    matchedMessage ??= match;
  }
  return matchedMessage;
}

export async function waitForSlackScenarioReply(
  params: SlackScenarioObservationContext & {
    client: WebClient;
    threadTs?: string;
    timeoutMs: number;
  },
) {
  const startedAt = Date.now();
  const inspectMessages = (messages: SlackMessage[]) => {
    const matchedMessage = recordSlackScenarioMessages(params, messages);
    return matchedMessage
      ? { message: matchedMessage, observedAt: new Date().toISOString() }
      : undefined;
  };

  while (Date.now() - startedAt < params.timeoutMs) {
    const channelMessages = await listSlackMessages({
      channelId: params.channelId,
      client: params.client,
      oldestTs: params.sentTs,
    });
    const channelReply = inspectMessages(channelMessages);
    if (channelReply) {
      return channelReply;
    }

    try {
      const threadMessages = await listSlackThreadMessages({
        channelId: params.channelId,
        client: params.client,
        threadTs: params.threadTs ?? params.sentTs,
      });
      const threadReply = inspectMessages(threadMessages);
      if (threadReply) {
        return threadReply;
      }
    } catch (error) {
      throw new Error(
        `Slack conversations.replies failed while waiting for ${params.observationScenarioId}: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    await sleep(1_000);
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Slack message`);
}

export async function observeSlackScenarioMessages(
  params: SlackScenarioObservationContext & {
    client: WebClient;
    settleMs: number;
    threadTs?: string;
  },
) {
  const startedAt = Date.now();

  while (true) {
    recordSlackScenarioMessages(
      params,
      await listSlackMessages({
        channelId: params.channelId,
        client: params.client,
        oldestTs: params.sentTs,
      }),
    );
    try {
      recordSlackScenarioMessages(
        params,
        await listSlackThreadMessages({
          channelId: params.channelId,
          client: params.client,
          threadTs: params.threadTs ?? params.sentTs,
        }),
      );
    } catch (error) {
      throw new Error(
        `Slack conversations.replies failed while settling ${params.observationScenarioId}: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    const remainingMs = params.settleMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return;
    }
    await sleep(Math.min(1_000, remainingMs));
  }
}

export async function waitForSlackNoReply(
  params: SlackScenarioObservationContext & { client: WebClient; timeoutMs: number },
) {
  const startedAt = Date.now();
  const observedKeys = new Set(
    params.observedMessages
      .map((message) => `${message.channelId ?? params.channelId}:${message.ts ?? ""}`)
      .filter((key) => !key.endsWith(":")),
  );
  let elapsedMs = Date.now() - startedAt;
  while (elapsedMs < params.timeoutMs) {
    const messages = await listSlackMessages({
      channelId: params.channelId,
      client: params.client,
      oldestTs: params.sentTs,
    });
    for (const message of messages) {
      if (recordSlackScenarioMessage(params, message, observedKeys)) {
        throw new Error("unexpected Slack SUT reply observed");
      }
    }
    elapsedMs = Date.now() - startedAt;
    const remainingMs = params.timeoutMs - elapsedMs;
    if (remainingMs > 0) {
      await sleep(Math.min(1_000, remainingMs));
    }
    elapsedMs = Date.now() - startedAt;
  }
}

async function waitForSlackChannelRunning(
  gateway: QaGatewayChild,
  accountId: string,
  mode: SlackChannelReadinessMode,
): Promise<SlackChannelStatus> {
  const startedAt = Date.now();
  const timeoutMs = resolveSlackQaReadyTimeoutMs();
  let lastStatus: SlackChannelStatus | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const accounts = await readLiveQaChannelAccounts(gateway, "slack");
      const match = accounts.find((entry) => entry.accountId === accountId);
      lastStatus = match
        ? {
            connected: match.connected,
            lastConnectedAt: match.lastConnectedAt,
            lastDisconnect: match.lastDisconnect,
            lastError: match.lastError,
            restartPending: match.restartPending,
            running: match.running,
          }
        : undefined;
      if (lastStatus && isSlackChannelReadyForQa(lastStatus, mode)) {
        return lastStatus;
      }
    } catch {
      // retry
    }
    await sleep(500);
  }
  throw new Error(
    `slack account "${accountId}" did not become ready` +
      (lastStatus ? `; last status: ${JSON.stringify(lastStatus)}` : ""),
  );
}

export async function waitForSlackChannelStable(
  gateway: QaGatewayChild,
  accountId: string,
  mode: SlackChannelReadinessMode,
) {
  const startedAt = Date.now();
  const timeoutMs = resolveSlackQaReadyTimeoutMs();
  let readySince: number | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    const status = await waitForSlackChannelRunning(gateway, accountId, mode);
    const observedAt = Date.now();
    readySince = resolveSlackChannelReadySince({
      observedAt,
      previousReadySince: readySince,
      status,
    });
    const readyForMs = observedAt - readySince;
    if (readyForMs >= SLACK_QA_READY_STABILITY_MS) {
      return;
    }
    await sleep(Math.max(500, SLACK_QA_READY_STABILITY_MS - readyForMs));
  }
  throw new Error(
    `slack account "${accountId}" did not remain ready for ${SLACK_QA_READY_STABILITY_MS}ms`,
  );
}

function isSlackChannelReadyForQa(
  status: SlackChannelStatus | undefined,
  mode: SlackChannelReadinessMode,
): boolean {
  if (
    !status?.running ||
    status.restartPending === true ||
    status.lastError != null ||
    status.connected === false
  ) {
    return false;
  }
  return mode === "started" || status.connected === true;
}

function resolveSlackChannelReadySince(params: {
  observedAt: number;
  previousReadySince: number | undefined;
  status: SlackChannelStatus;
}): number {
  if (typeof params.status.lastConnectedAt === "number" && params.status.lastConnectedAt > 0) {
    return params.status.lastConnectedAt;
  }
  return params.previousReadySince ?? params.observedAt;
}

function resolveSlackQaReadyTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS;
  if (!raw) {
    return SLACK_QA_DEFAULT_READY_TIMEOUT_MS;
  }
  return parseStrictPositiveInteger(raw) ?? SLACK_QA_DEFAULT_READY_TIMEOUT_MS;
}
