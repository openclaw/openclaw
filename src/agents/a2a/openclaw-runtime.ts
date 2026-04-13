import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { readLatestAssistantReply, waitForAgentRun } from "../run-wait.js";
import { runAgentStep } from "../tools/agent-step.js";
import { resolveAnnounceTarget } from "../tools/sessions-announce-target.js";
import type { A2ABrokerRuntime } from "./types.js";

const log = createSubsystemLogger("agents/sessions-send");

type GatewayCaller = typeof callGateway;

const defaultSessionsSendA2ADeps = {
  callGateway,
};

let sessionsSendA2ADeps: {
  callGateway: GatewayCaller;
} = defaultSessionsSendA2ADeps;

export function createOpenClawA2ABrokerRuntime(): A2ABrokerRuntime {
  return {
    async waitForInitialReply(params) {
      const wait = await waitForAgentRun({
        runId: params.waitRunId,
        timeoutMs: params.timeoutMs,
        callGateway: sessionsSendA2ADeps.callGateway,
      });
      if (wait.status !== "ok") {
        return undefined;
      }
      return readLatestAssistantReply({
        sessionKey: params.targetSessionKey,
      });
    },
    resolveAnnounceTarget(params) {
      return resolveAnnounceTarget({
        sessionKey: params.targetSessionKey,
        displayKey: params.displayKey,
      });
    },
    async runReplyStep(params) {
      const reply = await runAgentStep({
        sessionKey: params.sessionKey,
        message: params.incomingMessage,
        extraSystemPrompt: params.extraSystemPrompt,
        timeoutMs: params.timeoutMs,
        lane: AGENT_LANE_NESTED,
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel as GatewayMessageChannel | undefined,
        sourceTool: "sessions_send",
      });
      return { reply: reply ?? undefined };
    },
    async runAnnounceStep(params) {
      const reply = await runAgentStep({
        sessionKey: params.sessionKey,
        message: "Agent-to-agent announce step.",
        extraSystemPrompt: params.extraSystemPrompt,
        timeoutMs: params.timeoutMs,
        lane: AGENT_LANE_NESTED,
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel as GatewayMessageChannel | undefined,
        sourceTool: "sessions_send",
      });
      return { reply: reply ?? undefined };
    },
    async publishAnnouncement(params) {
      try {
        await sessionsSendA2ADeps.callGateway({
          method: "send",
          params: {
            to: params.target.to,
            message: params.message,
            channel: params.target.channel,
            accountId: params.target.accountId,
            threadId: params.target.threadId,
            idempotencyKey: crypto.randomUUID(),
          },
          timeoutMs: 10_000,
        });
        return { status: "sent" } as const;
      } catch (err) {
        const errorMessage = formatErrorMessage(err);
        log.warn("sessions_send announce delivery failed", {
          channel: params.target.channel,
          to: params.target.to,
          error: errorMessage,
        });
        return { status: "failed", errorMessage } as const;
      }
    },
    async abortTaskRun(params) {
      try {
        const response = await sessionsSendA2ADeps.callGateway({
          method: "sessions.abort",
          params: {
            key: params.sessionKey,
            ...(params.runId ? { runId: params.runId } : {}),
          },
          timeoutMs: 10_000,
        });
        const status = response?.status === "aborted" ? "aborted" : "no-active-run";
        return {
          attempted: true,
          aborted: status === "aborted",
          status,
        };
      } catch (err) {
        return {
          attempted: true,
          aborted: false,
          status: "error",
          errorMessage: formatErrorMessage(err),
        };
      }
    },
    warn(event, meta) {
      log.warn(event, meta);
    },
  };
}

export const __testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    sessionsSendA2ADeps = overrides
      ? {
          ...defaultSessionsSendA2ADeps,
          ...overrides,
        }
      : defaultSessionsSendA2ADeps;
  },
};
