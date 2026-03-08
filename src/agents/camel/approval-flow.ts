import crypto from "node:crypto";
import readline from "node:readline";
import { callGateway } from "../../gateway/call.js";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  type ExecApprovalDecision,
} from "../../infra/exec-approvals.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { sanitizeForPromptLiteral } from "../sanitize-for-prompt.js";
import type { ApprovalHandler, ApprovalRequest } from "./types.js";

type GatewayApprovalContext = {
  sessionKey?: string;
  agentId?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

type GatewayApprovalRequester = (params: {
  id: string;
  command: string;
  timeoutMs: number;
  context: GatewayApprovalContext;
}) => Promise<ExecApprovalDecision | null>;

function sanitizeApprovalText(value: string, maxChars = 2_000): string {
  const normalized = sanitizeForPromptLiteral(value).replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}…`;
}

function wrapApprovalContent(content: string): string {
  if (!content.includes("\n") && !content.includes("`")) {
    return `\`${content}\``;
  }
  let fence = "```";
  while (content.includes(fence)) {
    fence += "`";
  }
  return `${fence}\n${content}\n${fence}`;
}

function buildGatewayApprovalCommand(request: ApprovalRequest): string {
  const lines = [
    "[CaMeL] Tainted side-effect approval required",
    `Tool: ${sanitizeApprovalText(request.toolName, 200)}`,
    `Reason: ${sanitizeApprovalText(request.reason, 800)}`,
  ];
  const content = sanitizeApprovalText(request.content ?? "", 4_000);
  if (content) {
    lines.push("Sanitized content:");
    lines.push(wrapApprovalContent(content));
  }
  return lines.join("\n");
}

const requestGatewayApprovalDecision: GatewayApprovalRequester = async (params) => {
  const response = await callGateway<{ decision?: string | null }>({
    method: "exec.approval.request",
    params: {
      id: params.id,
      command: params.command,
      timeoutMs: params.timeoutMs,
      host: "gateway",
      security: "allowlist",
      ask: "always",
      sessionKey: params.context.sessionKey ?? undefined,
      agentId: params.context.agentId ?? undefined,
      turnSourceChannel: params.context.turnSourceChannel ?? undefined,
      turnSourceTo: params.context.turnSourceTo ?? undefined,
      turnSourceAccountId: params.context.turnSourceAccountId ?? undefined,
      turnSourceThreadId: params.context.turnSourceThreadId ?? undefined,
      source: "camel",
    },
    timeoutMs: params.timeoutMs + 10_000,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "CaMeL approval",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  });
  const decision = response?.decision;
  return decision === "allow-once" || decision === "allow-always" || decision === "deny"
    ? decision
    : null;
};

export function createApprovalPromptHandler(params?: {
  timeoutMs?: number;
  prompt?: (request: ApprovalRequest) => Promise<boolean>;
  gatewayApproval?: GatewayApprovalContext;
  gatewayRequester?: GatewayApprovalRequester;
}): ApprovalHandler {
  const timeoutMs = params?.timeoutMs ?? DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
  if (params?.prompt) {
    return params.prompt;
  }

  return async (request) => {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      const hasGatewayRoutingContext = Boolean(
        params?.gatewayApproval?.sessionKey ||
        params?.gatewayApproval?.turnSourceChannel ||
        params?.gatewayApproval?.turnSourceTo,
      );
      if (hasGatewayRoutingContext) {
        try {
          const decision = await (params?.gatewayRequester ?? requestGatewayApprovalDecision)({
            id: crypto.randomUUID(),
            command: buildGatewayApprovalCommand(request),
            timeoutMs,
            context: params?.gatewayApproval ?? {},
          });
          return decision === "allow-once" || decision === "allow-always";
        } catch (error) {
          console.warn(
            `[camel approval] gateway approval request failed for ${request.toolName}: ${String(error)}`,
          );
          return false;
        }
      }
      console.warn(
        `[camel approval] denying ${request.toolName}: non-interactive TTY (stdin/stderr missing).`,
      );
      return false;
    }

    return new Promise((resolve) => {
      let settled = false;
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });

      const finish = (approved: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        rl.close();
        resolve(approved);
      };

      const timeout = setTimeout(() => finish(false), timeoutMs);
      rl.question(
        `\n[camel approval] Allow ${request.toolName}? ${request.reason} (y/N) `,
        (answer) => {
          finish(answer.trim().toLowerCase() === "y");
        },
      );
    });
  };
}

export async function requestApproval(
  request: ApprovalRequest,
  handler: ApprovalHandler,
): Promise<boolean> {
  return handler(request);
}
