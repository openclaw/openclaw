import { resolveExecApprovalCommandDisplay } from "openclaw/plugin-sdk/approval-runtime";
import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunner,
  type LobsterRunnerParams,
} from "./lobster-runner.js";
type LobsterToolOptions = {
  runner?: LobsterRunner;
  context?: OpenClawPluginToolContext;
};

const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_APPROVAL_CHECKPOINTS = 8;
// Match plugin.approval.request limits without truncating operator review content.
const MAX_APPROVAL_PROMPT_LENGTH = 512;
const MAX_APPROVAL_DETAIL_LENGTH = 16_384;

type OperatorApprovalDecision = { decision: "allow-once" | "allow-always" | "deny" | null };

function approvalDetailExceedsReviewLimit(detail: string): boolean {
  if (Array.from(detail).length > MAX_APPROVAL_DETAIL_LENGTH) {
    return true;
  }
  // The exec display escapes normalized line breaks, so it is at least as long
  // as the Gateway's warning-style detail after the same redaction.
  const normalized = detail.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n");
  return (
    resolveExecApprovalCommandDisplay({ command: normalized }).commandText.length >
    MAX_APPROVAL_DETAIL_LENGTH
  );
}

export function createLobsterTool(api: OpenClawPluginApi, options?: LobsterToolOptions) {
  const runner = options?.runner ?? createEmbeddedLobsterRunner();
  return {
    name: "lobster",
    label: "Lobster Workflow",
    description:
      "Run Lobster workflows with operator-reviewed approvals and structured input. For needs_input, ask the user the returned prompt, then resume with their answer as responseJson matching responseSchema. Approval checkpoints are handled by the operator, not by a resume tool call. Use cancel: true to cancel an input checkpoint.",
    parameters: Type.Object({
      action: Type.Enum(["run", "resume"], { type: "string" }),
      pipeline: Type.Optional(Type.String()),
      argsJson: Type.Optional(Type.String()),
      token: Type.Optional(Type.String()),
      responseJson: Type.Optional(
        Type.String({
          description: "User's answer as JSON for an input checkpoint. Use instead of approve.",
        }),
      ),
      cancel: Type.Optional(Type.Literal(true)),
      cwd: Type.Optional(
        Type.String({
          description:
            "Relative working directory (optional). Must stay within the gateway working directory.",
        }),
      ),
      timeoutMs: optionalPositiveIntegerSchema(),
      maxStdoutBytes: optionalPositiveIntegerSchema(),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const action = typeof params.action === "string" ? params.action.trim() : "";
      if (!action) {
        throw new Error("action required");
      }
      if (action !== "run" && action !== "resume") {
        throw new Error(`Unknown action: ${action}`);
      }
      if (params.approve !== undefined || params.approvalId !== undefined) {
        throw new Error("Lobster approval decisions are operator-only");
      }

      const cwd = resolveLobsterCwd(params.cwd);
      const timeoutMs = readPositiveIntegerParam(params, "timeoutMs") ?? 20_000;
      const maxStdoutBytes = readPositiveIntegerParam(params, "maxStdoutBytes") ?? 512_000;

      if (api.runtime?.version && api.logger?.debug) {
        api.logger.debug(`lobster plugin runtime=${api.runtime.version}`);
      }

      const runnerParams: LobsterRunnerParams = {
        action,
        ...(typeof params.pipeline === "string" ? { pipeline: params.pipeline } : {}),
        ...(typeof params.argsJson === "string" ? { argsJson: params.argsJson } : {}),
        ...(typeof params.token === "string" ? { token: params.token } : {}),
        ...(typeof params.responseJson === "string" ? { responseJson: params.responseJson } : {}),
        ...(typeof params.cancel === "boolean" ? { cancel: params.cancel } : {}),
        cwd,
        timeoutMs,
        maxStdoutBytes,
      };

      let envelope = await runner.run(runnerParams);
      let approvalCount = 0;
      while (envelope.ok && envelope.status === "needs_approval") {
        if (++approvalCount > MAX_APPROVAL_CHECKPOINTS) {
          throw new Error("Lobster workflow exceeded the approval checkpoint limit");
        }
        const checkpoint = envelope.requiresApproval;
        const token = checkpoint?.resumeToken?.trim() ?? "";
        const approvalId = checkpoint?.approvalId?.trim() ?? "";
        if (!checkpoint || (!token && !approvalId)) {
          throw new Error("Lobster approval checkpoint has no private continuation");
        }
        const resume: LobsterRunnerParams = {
          action: "resume",
          ...(token ? { token } : {}),
          ...(approvalId ? { approvalId } : {}),
          cwd,
          timeoutMs,
          maxStdoutBytes,
        };
        const assertInvocationCurrent = options?.context?.assertInvocationCurrent;
        if (!assertInvocationCurrent) {
          throw new Error("Lobster approval requires an active host invocation");
        }
        assertInvocationCurrent();
        const detail = JSON.stringify(checkpoint.items);
        const sizeError =
          Array.from(checkpoint.prompt).length > MAX_APPROVAL_PROMPT_LENGTH
            ? "Lobster approval prompt exceeds the Gateway's 512-character review limit; shorten the approval prompt and rerun the workflow"
            : approvalDetailExceedsReviewLimit(detail)
              ? "Lobster approval preview exceeds the Gateway's 16,384-character review limit; reduce the approval items and rerun the workflow"
              : null;
        if (sizeError) {
          await runner.run({ ...resume, approve: false }).catch(() => undefined);
          throw new Error(sizeError);
        }
        let decision: OperatorApprovalDecision;
        try {
          decision = await api.runtime.gateway.request<OperatorApprovalDecision>(
            "plugin.approval.request",
            {
              pluginId: api.id,
              title: "Lobster workflow approval",
              description: checkpoint.prompt,
              detail,
              allowedDecisions: ["allow-once", "deny"],
              toolName: "lobster",
              toolCallId: _id,
              ...(options?.context?.agentId ? { agentId: options.context.agentId } : {}),
              ...(options?.context?.sessionKey ? { sessionKey: options.context.sessionKey } : {}),
              ...(options?.context?.deliveryContext?.channel || options?.context?.messageChannel
                ? {
                    turnSourceChannel:
                      options.context.deliveryContext?.channel ?? options.context.messageChannel,
                  }
                : {}),
              ...(options?.context?.deliveryContext?.to
                ? { turnSourceTo: options.context.deliveryContext.to }
                : {}),
              ...(options?.context?.deliveryContext?.accountId || options?.context?.agentAccountId
                ? {
                    turnSourceAccountId:
                      options.context.deliveryContext?.accountId ?? options.context.agentAccountId,
                  }
                : {}),
              ...(options?.context?.deliveryContext?.threadId !== undefined
                ? { turnSourceThreadId: options.context.deliveryContext.threadId }
                : {}),
              timeoutMs: APPROVAL_TIMEOUT_MS,
            },
            { timeoutMs: APPROVAL_TIMEOUT_MS + 5_000 },
          );
        } catch {
          await runner.run({ ...resume, approve: false }).catch(() => undefined);
          throw new Error("Lobster approval route unavailable; workflow was not approved");
        }
        const approved = decision?.decision === "allow-once";
        if (approved) {
          assertInvocationCurrent();
        }
        envelope = await runner.run({
          ...resume,
          approve: approved,
          ...(approved ? { assertInvocationCurrent } : {}),
        });
      }
      if (!envelope.ok) {
        throw new Error(envelope.error.message);
      }
      return jsonResult(envelope);
    },
  };
}
