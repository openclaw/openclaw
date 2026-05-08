import type { OpenClawPluginApi, OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveConfiguredAgentkitPluginConfig } from "./config.js";
import {
  formatPendingAgentkitApprovalsText,
  listPendingAgentkitApprovals,
  resolveRequestedAgentkitApproval,
  type AgentkitPendingApproval,
} from "./hitl-approvals.js";
import {
  resolveHumanApprovalApprovalIdToken,
  resolveHumanApprovalCommandDecision,
} from "./human-approval-actions.js";
import { startOrReuseAgentkitHumanApprovalSession } from "./human-approval-background.js";
import { formatAgentkitStatusText, resolveAgentkitStatus } from "./status.js";

function formatUsage(statusText: string): string {
  return [
    "Usage: /agentkit status",
    "Usage: /agentkit approvals",
    "Usage: /agentkit approve [approval-id] [allow-once|allow-always]",
    "CLI-only: openclaw agentkit register",
    "CLI-only: openclaw agentkit verify-header",
    "CLI-only: openclaw agentkit verifier-server",
    "CLI-only: openclaw agentkit verifier-request",
    "CLI-only: openclaw agentkit request",
    "Usage: openclaw agentkit status",
    "",
    statusText,
  ].join("\n");
}

function buildFence(text: string): string {
  return ["```text", text, "```"].join("\n");
}

function formatCompactDuration(milliseconds: number): string {
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function resolveChatApprovalSelection(params: {
  approvalId?: string;
  approvals: AgentkitPendingApproval[];
  sessionKey?: string;
}): AgentkitPendingApproval {
  if (params.approvalId) {
    return resolveRequestedAgentkitApproval({
      approvals: params.approvals,
      approvalId: params.approvalId,
    });
  }
  if (params.sessionKey) {
    const sessionMatches = params.approvals.filter(
      (approval) => approval.request.sessionKey === params.sessionKey,
    );
    if (sessionMatches.length === 1) {
      return sessionMatches[0];
    }
  }
  return resolveRequestedAgentkitApproval({
    approvals: params.approvals,
  });
}

function formatHumanApprovalReply(params: {
  approvalId: string;
  connectorURI: string;
  decision: "allow-once" | "allow-always";
  pluginConfig: ReturnType<typeof resolveConfiguredAgentkitPluginConfig>;
  qrText: string | null;
  requestId: string;
  reused: boolean;
}): string {
  const scopeLabel = params.pluginConfig.hitl.grantScope === "agent" ? "agent" : "session";
  const lines = [params.reused ? "Verify with World is already in progress." : "Verify with World"];
  lines.push(`Approval: ${params.approvalId}`);
  lines.push(`World request: ${params.requestId}`);
  lines.push(
    params.decision === "allow-always"
      ? `Scope: matching protected tools in this ${scopeLabel} for ${formatCompactDuration(
          params.pluginConfig.hitl.grantTtlMs,
        )}.`
      : "Scope: this blocked action only.",
  );
  if (params.qrText) {
    lines.push("");
    lines.push("Scan with World App:");
    lines.push(buildFence(params.qrText));
  }
  lines.push("");
  lines.push(`Link: ${params.connectorURI}`);
  return lines.join("\n");
}

export function createAgentkitCommand(api: OpenClawPluginApi): OpenClawPluginCommandDefinition {
  return {
    name: "agentkit",
    description: "Inspect World AgentKit readiness, registration, and verifier flows.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const appConfig = ctx.config;
      const rawTokens = args.split(/\s+/).filter(Boolean);
      const normalizedTokens = rawTokens.map((token) => normalizeLowercaseStringOrEmpty(token));
      const [action = ""] = normalizedTokens;
      const status = await resolveAgentkitStatus({
        appConfig,
        env: process.env,
      });
      const statusText = formatAgentkitStatusText(status);

      if (!action || action === "help") {
        return { text: formatUsage(statusText) };
      }

      if (action === "status") {
        return { text: statusText };
      }

      if (action === "register") {
        return {
          text: [
            "AgentKit registration currently runs as a local host CLI flow.",
            "Run `openclaw agentkit register` on the host machine to start registration.",
            "",
            statusText,
          ].join("\n"),
        };
      }

      if (action === "approvals") {
        const approvals = await listPendingAgentkitApprovals({
          appConfig,
        });
        return {
          text: formatPendingAgentkitApprovalsText(approvals),
        };
      }

      if (action === "approve") {
        const pluginConfig = resolveConfiguredAgentkitPluginConfig(appConfig);
        if (pluginConfig.hitl.mode !== "human-approval") {
          return {
            text: [
              "AgentKit HITL approval resolution currently runs as a local host CLI flow in delegation mode.",
              "Use `openclaw agentkit approvals` to list pending requests and `openclaw agentkit approve --approval-id <id> --private-key-file <path>` to resolve one after proof verification.",
              "",
              statusText,
            ].join("\n"),
          };
        }

        const approvals = await listPendingAgentkitApprovals({
          appConfig,
        });
        const trailingTokens = rawTokens.slice(1);
        const approvalToken = resolveHumanApprovalApprovalIdToken(trailingTokens) ?? "";
        const decision = resolveHumanApprovalCommandDecision(trailingTokens) ?? "allow-once";
        try {
          const approval = resolveChatApprovalSelection({
            approvalId: approvalToken || undefined,
            approvals,
            sessionKey: ctx.sessionKey,
          });
          const session = await startOrReuseAgentkitHumanApprovalSession({
            appConfig,
            approval,
            decision,
            env: process.env,
            logger: api.logger,
            pluginConfig,
          });
          return {
            text: [
              formatHumanApprovalReply({
                approvalId: approval.id,
                connectorURI: session.connectorURI,
                decision:
                  session.decision === "allow-always" ? "allow-always" : ("allow-once" as const),
                pluginConfig,
                qrText: session.qrText,
                requestId: session.requestId,
                reused: session.reused,
              }),
            ].join("\n"),
          };
        } catch (error) {
          return {
            text: [
              error instanceof Error ? error.message : "Failed to start World verification.",
              "",
              formatPendingAgentkitApprovalsText(approvals),
            ].join("\n"),
          };
        }
      }

      if (action === "verify" || action === "verify-header") {
        return {
          text: [
            "AgentKit header verification currently runs as a local host CLI flow.",
            "Run `openclaw agentkit verify-header --resource <url> --header-file <path>` on the host machine.",
            "",
            statusText,
          ].join("\n"),
        };
      }

      if (action === "request") {
        return {
          text: [
            "AgentKit protected-resource requests currently run as a local host CLI flow.",
            "Run `openclaw agentkit request --resource <url> [--private-key-file <path>]` on the host machine.",
            "",
            statusText,
          ].join("\n"),
        };
      }

      if (action === "verifier-server" || action === "verifier-request") {
        return {
          text: [
            "AgentKit verifier server and request flows currently run as local host CLI commands.",
            "Run `openclaw agentkit verifier-server` and `openclaw agentkit verifier-request --server <origin> [--private-key-file <path>]` on the host machine.",
            "",
            statusText,
          ].join("\n"),
        };
      }

      return { text: formatUsage(statusText) };
    },
  };
}
