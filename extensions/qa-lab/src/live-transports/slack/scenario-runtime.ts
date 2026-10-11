import { setTimeout as sleep } from "node:timers/promises";
import { buildLiveTransportRttResult } from "../shared/live-transport-rtt.js";
import type { SlackQaScenarioEnvironment } from "./scenario-environment.js";
import { runSlackApprovalScenario } from "./slack-live.approvals.js";
import { runSlackCodexApprovalScenario } from "./slack-live.codex-approval-runner.js";
import type {
  SlackQaMessageScenarioRun,
  SlackObservedMessage,
  SlackQaScenarioImplementation,
} from "./slack-live.contracts.js";
import {
  observeSlackScenarioMessages,
  waitForSlackNoReply,
  waitForSlackScenarioReply,
} from "./slack-live.message-observations.js";
import { recordSlackObservedMessage, sendSlackChannelMessage } from "./slack-live.observations.js";

async function waitForSlackPreReplyCapture(params: {
  capture: NonNullable<SlackQaMessageScenarioRun["captureBeforeReply"]>;
  channelId: string;
  readMessages: () => Promise<SlackObservedMessage[]>;
  scenarioId: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  while (true) {
    const messages = (await params.readMessages()).filter(
      (message) => message.channelId === params.channelId,
    );
    if (params.capture(messages)) {
      return;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `timed out after ${params.timeoutMs}ms waiting for ${params.scenarioId} write capture`,
      );
    }
    await sleep(Math.min(25, remainingMs));
  }
}

export {
  slackQaAllowlistBlockScenario,
  slackQaApprovalExecNativeScenario,
  slackQaApprovalPluginNativeScenario,
  slackQaCanaryScenario,
  slackQaChannelDisabledWarningScenario,
  slackQaChartPresentationNativeScenario,
  slackQaCodexApprovalExecNativeScenario,
  slackQaCodexApprovalPluginNativeScenario,
  slackQaMentionGatingScenario,
  slackQaMpimAppMentionDedupeScenario,
  slackQaProgressCommentaryFalseScenario,
  slackQaProgressCommentaryOmittedScenario,
  slackQaProgressCommentaryTrueScenario,
  slackQaProgressCommentaryVerboseDedupeScenario,
  slackQaProgressCommentaryVerboseFullScenario,
  slackQaReactionGlyphNativeScenario,
  slackQaTableInvalidBlocksFallbackScenario,
  slackQaTablePresentationNativeScenario,
  slackQaTopLevelReplyShapeScenario,
} from "./slack-live.scenario-implementations.js";

async function runSlackMessageScenario(
  environment: SlackQaScenarioEnvironment,
  run: SlackQaMessageScenarioRun,
) {
  const { scenario } = environment;
  let scenarioContext = environment.context;
  let ownedRequest: { cursor: number; messageId: string } | undefined;
  try {
    const beforeRunResult = await run.beforeRun?.(environment.context);
    const beforeRunDetails =
      typeof beforeRunResult === "string" ? beforeRunResult : beforeRunResult?.details;
    const channelId =
      typeof beforeRunResult === "object" && beforeRunResult.inputChannelId?.trim()
        ? beforeRunResult.inputChannelId.trim()
        : environment.channelId;
    scenarioContext = { ...environment.context, channelId };
    const observedMessageStartIndex = environment.observedMessages.length;
    const messageWriteCursor = await environment.getMessageWriteCursor();
    const requestStartedAt = new Date();
    const threadTs =
      typeof beforeRunResult === "object" ? beforeRunResult?.inputThreadTs : undefined;
    const owned =
      environment.channelE2e && channelId === environment.channelId
        ? await environment.channelE2e.send({
            text: run.input,
            mention: false,
            threadId: threadTs,
          })
        : undefined;
    const sent = owned
      ? { channelId: owned.channelId, ts: owned.id }
      : await sendSlackChannelMessage({
          channelId,
          client: environment.context.driverClient,
          text: run.input,
          threadTs,
        });
    if (owned) {
      ownedRequest = { cursor: messageWriteCursor, messageId: owned.id };
    }
    const requestThreadTs =
      (typeof beforeRunResult === "object" ? beforeRunResult?.inputThreadTs : undefined) ?? sent.ts;
    const observation = {
      channelId,
      client: environment.context.sutReadClient,
      matchText: run.matchText,
      observedMessages: environment.observedMessages,
      observationScenarioId: scenario.id,
      observationScenarioTitle: scenario.title,
      sentTs: sent.ts,
      sutIdentity: environment.sutIdentity,
    };
    if (!run.expectReply) {
      await waitForSlackNoReply({
        ...observation,
        timeoutMs: run.noReplyObservationMs ?? scenario.timeoutMs,
      });
      const afterNoReplyDetails = await run.afterNoReply?.({
        ...scenarioContext,
        sentTs: sent.ts,
      });
      return {
        details: ["no reply", beforeRunDetails, afterNoReplyDetails].filter(Boolean).join("; "),
      };
    }
    if (run.captureBeforeReply) {
      // Native presentation identity belongs to the successful write capture. Resolve it
      // before shared channel history can evict the earlier message while awaiting the final reply.
      await waitForSlackPreReplyCapture({
        capture: run.captureBeforeReply,
        channelId,
        readMessages: () => environment.readMessageWrites(messageWriteCursor),
        scenarioId: scenario.id,
        timeoutMs: scenario.timeoutMs,
      });
    }
    const reply = await waitForSlackScenarioReply({
      ...observation,
      threadTs: requestThreadTs,
      timeoutMs: scenario.timeoutMs,
    });
    run.verify?.(reply.message, { requestThreadTs, sentTs: sent.ts });
    if (run.settleObservedMs) {
      await observeSlackScenarioMessages({
        ...observation,
        settleMs: run.settleObservedMs,
        threadTs: requestThreadTs,
      });
    }
    const capturedMessages = await environment.readMessageWrites(messageWriteCursor);
    const observedDetails = run.verifyObserved?.({
      finalMessage: reply.message,
      messages: [
        ...environment.observedMessages.slice(observedMessageStartIndex),
        ...capturedMessages.filter((message) => message.channelId === channelId),
      ],
    });
    const afterReplyDetails = await run.afterReply?.(reply.message, {
      ...scenarioContext,
      sentTs: sent.ts,
    });
    const responseObservedAt = new Date(reply.observedAt);
    const rttMs = responseObservedAt.getTime() - requestStartedAt.getTime();
    return {
      details: [`reply matched in ${rttMs}ms`, beforeRunDetails, observedDetails, afterReplyDetails]
        .filter(Boolean)
        .join("; "),
      ...buildLiveTransportRttResult(
        { requestStartedAt, responseObservedAt, rttMs },
        "request-to-observed-message",
      ),
    };
  } finally {
    try {
      if (ownedRequest && environment.recordScenarioMessages) {
        const messages = await environment.readMessageWrites(ownedRequest.cursor);
        await environment.recordScenarioMessages(
          ownedRequest.messageId,
          messages.map((message) => message.ts).filter((ts): ts is string => Boolean(ts)),
        );
      }
    } finally {
      await run.cleanup?.(scenarioContext);
    }
  }
}

export async function runSlackScenario(
  environment: SlackQaScenarioEnvironment,
  implementation: SlackQaScenarioImplementation,
) {
  const scenario = environment.scenario;
  const { cfg, primaryModel, run } = await environment.configureScenario(implementation);
  if (run.kind === "direct-transport") {
    const result = await run.execute({
      cfg,
      channelId: environment.channelId,
      sutAccountId: environment.sutAccountId,
      sutIdentity: environment.sutIdentity,
      sutReadClient: environment.context.sutReadClient,
      sutWriteClient: environment.sutWriteClient,
      timeoutMs: scenario.timeoutMs,
    });
    const message = result.message;
    if (!message.ts) {
      throw new Error("direct Slack transport scenario returned no stored message id");
    }
    recordSlackObservedMessage({
      channelId: environment.channelId,
      matchedScenario: true,
      message,
      observedMessages: environment.observedMessages,
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
    });
    return { details: result.details };
  }
  if (run.kind === "approval" || run.kind === "codex-approval") {
    const params = {
      channelId: environment.channelId,
      context: environment.context,
      observedMessages: environment.observedMessages,
      scenario,
      sutAccountId: environment.sutAccountId,
    };
    const approval =
      run.kind === "approval"
        ? await runSlackApprovalScenario({ ...params, run })
        : await runSlackCodexApprovalScenario({
            ...params,
            primaryModel,
            run,
            stopGateway: environment.stopGateway,
          });
    const label = run.kind === "approval" ? run.approvalKind : `Codex ${run.appServerMethod}`;
    return {
      details: `${label} approval resolved ${run.decision} in ${approval.rttMs}ms`,
      artifacts: { approval: approval.artifact },
      ...buildLiveTransportRttResult(approval, "approval-request-to-resolution"),
    };
  }
  return await runSlackMessageScenario(environment, run);
}
