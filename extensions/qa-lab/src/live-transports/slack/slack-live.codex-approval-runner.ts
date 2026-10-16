import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  completeSlackApprovalScenario,
  waitForSlackApprovalMessage,
} from "./slack-live.approvals.js";
import {
  assertCodexApprovalOperationSucceeded,
  assertPendingCodexPluginApproval,
  startCodexApprovalAgentRun,
  buildCodexApprovalSessionKey,
  waitForCodexApprovalAgentRun,
  quiesceCodexApprovalAgentRun,
  resolveCodexFileApprovalTargetPath,
} from "./slack-live.codex-approval.js";
import type {
  SlackQaCodexApprovalScenarioRun,
  SlackQaApprovalContext,
  SlackQaScenarioMetadata,
  SlackObservedMessage,
  SlackApprovalArtifact,
} from "./slack-live.contracts.js";

export async function runSlackCodexApprovalScenario(params: {
  channelId: string;
  context: SlackQaApprovalContext;
  observedMessages: SlackObservedMessage[];
  primaryModel: string;
  run: SlackQaCodexApprovalScenarioRun;
  scenario: SlackQaScenarioMetadata;
  stopGateway: (preserveDebugArtifacts: boolean) => Promise<void>;
  sutAccountId: string;
}) {
  const codexRun = {
    runId: `slack-qa-codex-approval-${randomUUID()}`,
    sessionKey: buildCodexApprovalSessionKey({
      scenario: params.scenario,
      token: params.run.token,
    }),
  };
  const targetPath =
    params.run.appServerMethod === "item/fileChange/requestApproval"
      ? resolveCodexFileApprovalTargetPath(params.run.token)
      : undefined;
  if (targetPath) {
    await fs.rm(targetPath, { force: true });
  }
  const outcome = await runSlackCodexApprovalScenarioInner({ ...params, codexRun }).then(
    (result) => ({ kind: "success", result }) as const,
    (error: unknown) => ({ error, kind: "failure" }) as const,
  );
  // Kill the gateway process tree before deleting the probe. Agent completion
  // does not prove the native Codex turn has stopped writing after an interrupt.
  const cleanupErrors: unknown[] = [];
  try {
    await quiesceCodexApprovalAgentRun({
      context: params.context,
      preserveDebugArtifacts: outcome.kind === "failure",
      stopGateway: params.stopGateway,
      ...codexRun,
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length === 0 && targetPath) {
    try {
      await fs.rm(targetPath, { force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    const cleanupSummary = cleanupErrors.map(formatErrorMessage).join("; ");
    if (outcome.kind === "failure") {
      throw new AggregateError(
        [outcome.error, ...cleanupErrors],
        `Codex approval scenario failed: ${formatErrorMessage(outcome.error)}; cleanup also failed: ${cleanupSummary}`,
        { cause: outcome.error },
      );
    }
    throw new AggregateError(cleanupErrors, `Codex approval cleanup failed: ${cleanupSummary}`);
  }
  if (outcome.kind === "failure") {
    throw outcome.error;
  }
  return outcome.result;
}

async function runSlackCodexApprovalScenarioInner(params: {
  channelId: string;
  codexRun: { runId: string; sessionKey: string };
  context: SlackQaApprovalContext;
  observedMessages: SlackObservedMessage[];
  primaryModel: string;
  run: SlackQaCodexApprovalScenarioRun;
  scenario: SlackQaScenarioMetadata;
  sutAccountId: string;
}) {
  const requestStartedAt = new Date();
  const oldestTs = ((requestStartedAt.getTime() - 5_000) / 1_000).toFixed(6);
  await startCodexApprovalAgentRun({
    channelId: params.channelId,
    context: params.context,
    primaryModel: params.primaryModel,
    run: params.run,
    runId: params.codexRun.runId,
    scenario: params.scenario,
    sessionKey: params.codexRun.sessionKey,
    sutAccountId: params.sutAccountId,
  });
  const expectedTitle =
    params.run.appServerMethod === "item/commandExecution/requestApproval"
      ? "Codex app-server command approval"
      : "Codex app-server file approval";
  const observation = {
    approvalKind: params.run.approvalKind,
    channelId: params.channelId,
    client: params.context.sutReadClient,
    decision: params.run.decision,
    extraTextMatches: ["codex", expectedTitle],
    observedMessages: params.observedMessages,
    oldestTs,
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
    sutIdentity: params.context.sutIdentity,
    timeoutMs: params.scenario.timeoutMs,
  };
  const pending = await waitForSlackApprovalMessage({
    ...observation,
    state: "pending",
  });
  const approvalId = pending.approvalId;
  if (!approvalId) {
    throw new Error(
      "Codex Slack approval prompt exposed native actions but no plugin approval id.",
    );
  }
  await assertPendingCodexPluginApproval({
    approvalId,
    appServerMethod: params.run.appServerMethod,
    channelId: params.channelId,
    context: params.context,
    sessionKey: params.codexRun.sessionKey,
    sutAccountId: params.sutAccountId,
  });
  const completed = await completeSlackApprovalScenario({
    approvalId,
    gateway: params.context.gateway,
    observation,
    pending,
    requestStartedAt,
    verifyDecision: async () => {
      const finalCodexTurnStatus = await waitForCodexApprovalAgentRun({
        context: params.context,
        runId: params.codexRun.runId,
        timeoutMs: params.scenario.timeoutMs,
      });
      if (finalCodexTurnStatus !== "ok") {
        throw new Error(
          `Codex approval run ${params.codexRun.runId} finished with status ${finalCodexTurnStatus}`,
        );
      }
      await assertCodexApprovalOperationSucceeded({
        context: params.context,
        run: params.run,
        sessionKey: params.codexRun.sessionKey,
      });
    },
  });
  return {
    ...completed,
    artifact: {
      ...completed.artifact,
      appServerMethod: params.run.appServerMethod,
      codexModelKey: params.primaryModel,
      finalCodexTurnStatus: "ok",
      operationVerified: true,
    } satisfies SlackApprovalArtifact,
  };
}
