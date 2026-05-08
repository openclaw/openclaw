import type {
  ExecApprovalActionDescriptor,
  ExecApprovalDecision,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type { AgentkitPluginConfig } from "./config.js";

export type HumanApprovalCommandDecision = "allow-always" | "allow-once";

type HumanApprovalActionTemplate = {
  kind: "decision" | "command";
  label: string;
  style: "primary" | "success" | "danger";
  decision?: ExecApprovalDecision;
  commandTemplate: string;
};

export function resolveHumanApprovalPersistentLabel(pluginConfig: AgentkitPluginConfig): string {
  return pluginConfig.hitl.grantScope === "agent"
    ? "Verify and trust for agent"
    : "Verify and trust for session";
}

export function buildHumanApprovalActionTemplates(
  pluginConfig: AgentkitPluginConfig,
): HumanApprovalActionTemplate[] {
  return [
    {
      kind: "command",
      label: "Verify with World (Once)",
      style: "primary",
      commandTemplate: "/agentkit approve {id} allow-once",
    },
    {
      kind: "command",
      label: resolveHumanApprovalPersistentLabel(pluginConfig),
      style: "success",
      commandTemplate: "/agentkit approve {id} allow-always",
    },
    {
      kind: "decision",
      label: "Deny",
      style: "danger",
      decision: "deny",
      commandTemplate: "/approve {id} deny",
    },
  ];
}

export function buildHumanApprovalRetryActions(params: {
  approvalId: string;
  pluginConfig: AgentkitPluginConfig;
}): ExecApprovalActionDescriptor[] {
  return [
    {
      kind: "command",
      label: "Retry with World (Once)",
      style: "primary",
      command: `/agentkit approve ${params.approvalId} allow-once`,
    },
    {
      kind: "command",
      label: resolveHumanApprovalPersistentLabel(params.pluginConfig),
      style: "success",
      command: `/agentkit approve ${params.approvalId} allow-always`,
    },
    {
      kind: "decision",
      label: "Deny",
      style: "danger",
      decision: "deny",
      command: `/approve ${params.approvalId} deny`,
    },
  ];
}

export function buildHumanApprovalPendingActions(params: {
  approvalId: string;
  pluginConfig: AgentkitPluginConfig;
}): ExecApprovalActionDescriptor[] {
  return [
    {
      kind: "command",
      label: "Verify with World (Once)",
      style: "primary",
      command: `/agentkit approve ${params.approvalId} allow-once`,
    },
    {
      kind: "command",
      label: resolveHumanApprovalPersistentLabel(params.pluginConfig),
      style: "success",
      command: `/agentkit approve ${params.approvalId} allow-always`,
    },
    {
      kind: "decision",
      label: "Deny",
      style: "danger",
      decision: "deny",
      command: `/approve ${params.approvalId} deny`,
    },
  ];
}

export function resolveHumanApprovalCommandDecision(
  rawTokens: string[],
): HumanApprovalCommandDecision | null {
  const decisionToken = rawTokens
    .map((token) => token.trim().toLowerCase())
    .find((token) => token === "allow-once" || token === "allow-always");
  return decisionToken === "allow-always" || decisionToken === "allow-once" ? decisionToken : null;
}

export function resolveHumanApprovalApprovalIdToken(rawTokens: string[]): string | null {
  const approvalIdToken = rawTokens
    .map((token) => token.trim())
    .find((token) => token.length > 0 && token !== "allow-once" && token !== "allow-always");
  return approvalIdToken && approvalIdToken.length > 0 ? approvalIdToken : null;
}
