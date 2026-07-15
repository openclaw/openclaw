// QA Lab Slack artifact shaping and report rendering.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { appendQaLiveLaneIssue as appendLiveLaneIssue } from "../shared/live-artifacts.js";
import type {
  SlackQaGatewayHarness,
  SlackObservedMessage,
  SlackObservedMessageArtifact,
  SlackQaScenarioResult,
} from "./slack-live.contracts.js";

export function isRetryableSlackQaScenarioError(error: unknown) {
  return /timed out after \d+ms waiting for Slack message/iu.test(formatErrorMessage(error));
}

export function toObservedSlackArtifacts(params: {
  includeContent: boolean;
  messages: SlackObservedMessage[];
  redactMetadata: boolean;
}): SlackObservedMessageArtifact[] {
  return params.messages.map((message) => ({
    actionValues: params.includeContent ? message.actionValues : undefined,
    blockText: params.includeContent ? message.blockText : undefined,
    botId: params.redactMetadata ? undefined : message.botId,
    channelId: params.redactMetadata ? undefined : message.channelId,
    matchedScenario: message.matchedScenario,
    scenarioId: message.scenarioId,
    scenarioTitle: message.scenarioTitle,
    text: params.includeContent ? message.text : undefined,
    threadTs: params.redactMetadata ? undefined : message.threadTs,
    ts: params.redactMetadata ? undefined : message.ts,
    userId: params.redactMetadata ? undefined : message.userId,
  }));
}

export function toSlackQaScenarioArtifactResults(params: {
  includeContent: boolean;
  redactMetadata: boolean;
  scenarios: SlackQaScenarioResult[];
}): SlackQaScenarioResult[] {
  return params.scenarios.map((scenario) => {
    if (!scenario.approval) {
      return scenario;
    }
    const approval = scenario.approval;
    return {
      ...scenario,
      approval: {
        approvalId: params.redactMetadata ? "<redacted>" : approval.approvalId,
        approvalKind: approval.approvalKind,
        appServerMethod: approval.appServerMethod,
        channelId: params.redactMetadata ? undefined : approval.channelId,
        codexModelKey: approval.codexModelKey,
        decision: approval.decision,
        finalCodexTurnStatus: approval.finalCodexTurnStatus,
        operationVerified: approval.operationVerified,
        pendingActionValues: params.includeContent ? approval.pendingActionValues : undefined,
        pendingCheckpointPath: approval.pendingCheckpointPath,
        pendingMessageTs: params.redactMetadata ? undefined : approval.pendingMessageTs,
        pendingScreenshotPath: approval.pendingScreenshotPath,
        pendingText: params.includeContent ? approval.pendingText : undefined,
        resolvedActionValues: params.includeContent ? approval.resolvedActionValues : undefined,
        resolvedCheckpointPath: approval.resolvedCheckpointPath,
        resolvedMessageTs: params.redactMetadata ? undefined : approval.resolvedMessageTs,
        resolvedScreenshotPath: approval.resolvedScreenshotPath,
        resolvedText: params.includeContent ? approval.resolvedText : undefined,
        threadTs: params.redactMetadata ? undefined : approval.threadTs,
      },
    };
  });
}

export function renderSlackQaMarkdown(params: {
  channelId: string;
  cleanupIssues: string[];
  credentialSource: "convex" | "env";
  finishedAt: string;
  gatewayDebugDirPath?: string;
  redactMetadata: boolean;
  scenarios: SlackQaScenarioResult[];
  startedAt: string;
}) {
  const lines = [
    "# Slack QA Report",
    "",
    `- Credential source: \`${params.credentialSource}\``,
    `- Channel: \`${params.redactMetadata ? "<redacted>" : params.channelId}\``,
    `- Metadata redaction: \`${params.redactMetadata ? "enabled" : "disabled"}\``,
    `- Started: ${params.startedAt}`,
    `- Finished: ${params.finishedAt}`,
  ];
  if (params.gatewayDebugDirPath) {
    lines.push(`- Gateway debug artifacts: \`${params.gatewayDebugDirPath}\``);
  }
  if (params.cleanupIssues.length > 0) {
    lines.push("", "## Cleanup issues", "");
    for (const issue of params.cleanupIssues) {
      lines.push(`- ${issue}`);
    }
  }
  lines.push("", "## Scenarios", "");
  for (const scenario of params.scenarios) {
    lines.push(`### ${scenario.title}`, "");
    lines.push(`- Status: ${scenario.status}`);
    lines.push(`- Details: ${scenario.details}`);
    if (scenario.rttMs !== undefined) {
      lines.push(`- RTT: ${scenario.rttMs}ms`);
    }
    if (scenario.approval) {
      lines.push(`- Approval kind: ${scenario.approval.approvalKind}`);
      if (scenario.approval.appServerMethod) {
        lines.push(`- Codex app-server method: \`${scenario.approval.appServerMethod}\``);
      }
      if (scenario.approval.codexModelKey) {
        lines.push(`- Codex model: \`${scenario.approval.codexModelKey}\``);
      }
      if (scenario.approval.finalCodexTurnStatus) {
        lines.push(`- Codex turn status: ${scenario.approval.finalCodexTurnStatus}`);
      }
      if (scenario.approval.operationVerified) {
        lines.push("- Codex operation marker: verified");
      }
      lines.push(`- Approval ID: \`${scenario.approval.approvalId}\``);
      lines.push(`- Decision: ${scenario.approval.decision}`);
      if (scenario.approval.pendingScreenshotPath) {
        lines.push(`- Pending screenshot: \`${scenario.approval.pendingScreenshotPath}\``);
      }
      if (scenario.approval.resolvedScreenshotPath) {
        lines.push(`- Resolved screenshot: \`${scenario.approval.resolvedScreenshotPath}\``);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function preserveSlackGatewayDebugArtifacts(params: {
  cleanupIssues: string[];
  gatewayDebugDirPath: string;
  gatewayHarness: SlackQaGatewayHarness;
}) {
  try {
    await params.gatewayHarness.stop({ preserveToDir: params.gatewayDebugDirPath });
    return true;
  } catch (error) {
    appendLiveLaneIssue(params.cleanupIssues, "gateway debug preservation failed", error);
    return false;
  }
}
