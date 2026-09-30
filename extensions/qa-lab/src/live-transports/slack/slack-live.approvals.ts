import { randomUUID } from "node:crypto";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import {
  requestLiveQaApproval,
  resolveLiveQaApprovalDecision,
  waitForLiveQaApprovalDecision,
} from "../shared/live-approval-request.js";
import { assertApprovalDecisionResult } from "../shared/live-approval-result.js";
import { writeSlackApprovalCheckpoint } from "./slack-live.approval-checkpoint.js";
import {
  SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS,
  type SlackQaApprovalDecision,
  type SlackQaApprovalScenarioRun,
  type SlackQaScenarioContext,
  type SlackQaScenarioMetadata,
  type SlackAuthIdentity,
  type SlackObservedMessage,
  type SlackApprovalArtifact,
  type SlackQaWebClient as WebClient,
} from "./slack-live.contracts.js";
import {
  listSlackMessages,
  recordSlackObservedMessage,
  collectSlackBlockText,
  collectSlackActionValues,
  parseSlackNativeApprovalAction,
  hasSlackNativeApprovalActions,
  extractSlackNativeApprovalId,
  isSutSlackMessage,
} from "./slack-live.observations.js";

function resolveApprovalDecisionLabel(decision: SlackQaApprovalDecision) {
  return decision === "allow-once"
    ? "Allowed once"
    : decision === "allow-always"
      ? "Allowed always"
      : "Denied";
}

function resolveApprovalHeading(params: {
  approvalKind: ChannelApprovalKind;
  state: "pending" | "resolved";
  decision?: SlackQaApprovalDecision;
}) {
  if (params.state === "pending") {
    return params.approvalKind === "exec" ? "Exec approval required" : "Plugin approval required";
  }
  const label = resolveApprovalDecisionLabel(params.decision ?? "allow-once");
  return params.approvalKind === "exec" ? `Exec approval: ${label}` : `Plugin approval: ${label}`;
}

type SlackApprovalObservation = {
  approvalKind: ChannelApprovalKind;
  channelId: string;
  client: WebClient;
  decision: SlackQaApprovalDecision;
  observedMessages: SlackObservedMessage[];
  oldestTs: string;
  scenarioId: string;
  scenarioTitle: string;
  sutIdentity: SlackAuthIdentity;
  timeoutMs: number;
  token?: string;
  extraTextMatches?: string[];
};

export async function waitForSlackApprovalMessage(
  params: SlackApprovalObservation &
    ({ state: "pending"; approvalId?: string } | { state: "resolved"; messageTs: string }),
) {
  const startedAt = Date.now();
  const seenObservedMessages = new Set<string>();
  let lastMatchedWithoutActions = "";
  while (Date.now() - startedAt < params.timeoutMs) {
    const messages = await listSlackMessages(params);
    const candidates =
      params.state === "resolved"
        ? [messages.find((message) => message.ts === params.messageTs)]
        : messages;
    for (const message of candidates) {
      if (!message || !isSutSlackMessage(message, params.sutIdentity)) {
        continue;
      }
      if (params.state === "pending" && !message.ts) {
        continue;
      }
      const text = [message.text ?? "", ...collectSlackBlockText(message.blocks)].join("\n");
      const actionValues = collectSlackActionValues(message.blocks);
      const textMatches =
        text.includes(resolveApprovalHeading(params)) &&
        (!params.token || text.includes(params.token)) &&
        (params.extraTextMatches ?? []).every((match) => text.includes(match));
      const hasActions =
        params.state === "pending"
          ? hasSlackNativeApprovalActions({ ...params, actionValues })
          : actionValues.some((value) => parseSlackNativeApprovalAction(value));
      const matchedScenario = textMatches && (params.state === "pending" || !hasActions);
      const observedKey = `${message.ts}:${message.text ?? ""}:${actionValues.join("|")}`;
      if (
        (params.state === "resolved" || matchedScenario || hasActions) &&
        !seenObservedMessages.has(observedKey)
      ) {
        seenObservedMessages.add(observedKey);
        recordSlackObservedMessage({ ...params, matchedScenario, message });
      }
      if (!matchedScenario) {
        continue;
      }
      if (params.state === "pending" && !hasActions) {
        lastMatchedWithoutActions = `message ${message.ts} matched approval text but did not expose native approval button values`;
        continue;
      }
      return {
        actionValues,
        ...(params.state === "pending"
          ? {
              approvalId:
                params.approvalId ??
                extractSlackNativeApprovalId({ actionValues, decision: params.decision }),
            }
          : {}),
        message,
        observedAt: new Date().toISOString(),
      };
    }
    await sleep(1_000);
  }
  const label = params.state === "pending" ? "prompt" : "resolution update";
  throw new Error(
    [
      `timed out after ${params.timeoutMs}ms waiting for Slack ${params.approvalKind} approval ${label}`,
      lastMatchedWithoutActions,
    ]
      .filter(Boolean)
      .join("; "),
  );
}

export async function runSlackApprovalScenario(params: {
  channelId: string;
  context: Pick<SlackQaScenarioContext, "sutIdentity" | "sutReadClient"> & {
    gateway: Pick<SlackQaScenarioContext["gateway"], "call">;
  };
  observedMessages: SlackObservedMessage[];
  run: SlackQaApprovalScenarioRun;
  scenario: SlackQaScenarioMetadata;
  sutAccountId: string;
}) {
  const requestStartedAt = new Date();
  const oldestTs = ((requestStartedAt.getTime() - 5_000) / 1_000).toFixed(6);
  const requestedApprovalId =
    params.run.approvalKind === "exec"
      ? `slack-qa-exec-${randomUUID()}`
      : `slack-qa-plugin-${randomUUID()}`;
  const approvalId = await requestLiveQaApproval({
    approvalId: requestedApprovalId,
    approvalKind: params.run.approvalKind,
    channel: "slack",
    gateway: params.context.gateway,
    timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS,
    token: params.run.token,
    turnSourceTo: `channel:${params.channelId}`,
    sutAccountId: params.sutAccountId,
  });
  const observation = {
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    client: params.context.sutReadClient,
    decision: params.run.decision,
    observedMessages: params.observedMessages,
    oldestTs,
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
    sutIdentity: params.context.sutIdentity,
    timeoutMs: params.scenario.timeoutMs,
    token: params.run.token,
  };
  const pending = await waitForSlackApprovalMessage({
    ...observation,
    state: "pending",
    approvalId,
  });
  const checkpoint = {
    approvalId,
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    scenarioId: params.scenario.id,
  };
  const pendingCheckpoint = await writeSlackApprovalCheckpoint({
    ...checkpoint,
    message: pending.message,
    observedAt: pending.observedAt,
    state: "pending",
  });
  await resolveLiveQaApprovalDecision({
    approvalId,
    gateway: params.context.gateway,
    decision: params.run.decision,
    kind: params.run.approvalKind,
    timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
  });
  assertApprovalDecisionResult({
    decision: params.run.decision,
    result: await waitForLiveQaApprovalDecision({
      approvalId,
      gateway: params.context.gateway,
      kind: params.run.approvalKind,
      timeoutMs: SLACK_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    }),
  });
  const resolved = await waitForSlackApprovalMessage({
    ...observation,
    state: "resolved",
    messageTs: pending.message.ts,
  });
  const resolvedCheckpoint = await writeSlackApprovalCheckpoint({
    ...checkpoint,
    decision: params.run.decision,
    message: resolved.message,
    observedAt: resolved.observedAt,
    state: "resolved",
  });
  const responseObservedAt = new Date(resolved.observedAt);
  return {
    artifact: {
      approvalId,
      approvalKind: params.run.approvalKind,
      channelId: params.channelId,
      decision: params.run.decision,
      pendingActionValues: pending.actionValues,
      pendingCheckpointPath: pendingCheckpoint?.checkpointPath,
      pendingMessageTs: pending.message.ts,
      pendingScreenshotPath: pendingCheckpoint?.screenshotPath,
      pendingText: pending.message.text,
      resolvedActionValues: resolved.actionValues,
      resolvedCheckpointPath: resolvedCheckpoint?.checkpointPath,
      resolvedMessageTs: resolved.message.ts,
      resolvedScreenshotPath: resolvedCheckpoint?.screenshotPath,
      resolvedText: resolved.message.text,
      threadTs: pending.message.thread_ts,
    } satisfies SlackApprovalArtifact,
    requestStartedAt,
    responseObservedAt,
    rttMs: responseObservedAt.getTime() - requestStartedAt.getTime(),
  };
}
