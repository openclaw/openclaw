import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/plugin-runtime";
import { resolveConfiguredAgentkitPluginConfig } from "./config.js";
import { applyAgentkitHitlGrant, type AgentkitHitlGrantScope } from "./hitl-grants.js";
import { buildHumanApprovalActionTemplates } from "./human-approval-actions.js";
import { resolveAgentkitHumanApprovalRequestConfig } from "./human-approval.js";

const MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH = 256;

function isProtectedTool(toolName: string, protectedTools: string[]): boolean {
  if (protectedTools.length === 0) {
    return false;
  }
  return protectedTools.includes(toolName);
}

function resolveGrantScope(ctx: PluginHookToolContext): AgentkitHitlGrantScope {
  return {
    toolName: ctx.toolName,
    sessionKey: ctx.sessionKey ?? null,
    agentId: ctx.agentId ?? null,
  };
}

function buildApprovalDescription(params: {
  toolName: string;
  hitlMode: "delegation" | "human-approval";
  resourceUrl: string | null;
  grantScope: "session" | "agent";
}): string {
  const scopeLabel = params.grantScope === "agent" ? "this agent" : "this session";
  const lines =
    params.hitlMode === "human-approval"
      ? [
          `Verify with World before \`${params.toolName}\` runs in ${scopeLabel}.`,
          "Use the approval actions below, or list pending requests with `/agentkit approvals`.",
        ]
      : [
          `World proof of human is required before \`${params.toolName}\` can run for ${scopeLabel}.`,
          "Resolve the pending request with `openclaw agentkit approve --approval-id <id> --private-key-file <path>`.",
          "List pending requests with `openclaw agentkit approvals`.",
        ];
  if (params.hitlMode === "delegation" && params.resourceUrl) {
    lines.push(`Protected resource: ${params.resourceUrl}`);
  }
  const full = lines.join(" ");
  if (full.length <= MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH) {
    return full;
  }

  const fallback =
    params.hitlMode === "human-approval"
      ? [
          `World proof of human is required before \`${params.toolName}\` can run for ${scopeLabel}.`,
          "Use `openclaw agentkit approvals` then `openclaw agentkit approve --approval-id <id>` and scan the World QR.",
        ].join(" ")
      : [
          `World proof of human is required before \`${params.toolName}\` can run for ${scopeLabel}.`,
          "Use `openclaw agentkit approvals` then `openclaw agentkit approve --approval-id <id> --private-key-file <path>`.",
        ].join(" ");
  if (fallback.length <= MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH) {
    return fallback;
  }
  return fallback.slice(0, MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH - 1).trimEnd() + "…";
}

export function createAgentkitBeforeToolCallHook(
  api: OpenClawPluginApi,
): (
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
) => Promise<PluginHookBeforeToolCallResult | undefined> {
  return async (_event, ctx) => {
    const appConfig = api.runtime.config.current() as OpenClawConfig;
    const pluginConfig = resolveConfiguredAgentkitPluginConfig(appConfig);
    if (!pluginConfig.hitl.enabled) {
      return undefined;
    }
    if (!isProtectedTool(ctx.toolName, pluginConfig.hitl.protectedTools)) {
      return undefined;
    }
    if (pluginConfig.hitl.mode === "delegation" && !pluginConfig.hitl.resourceUrl) {
      return {
        block: true,
        blockReason:
          "AgentKit HITL is enabled for this tool, but no protected resource URL is configured.",
      };
    }
    if (pluginConfig.hitl.mode === "human-approval") {
      try {
        resolveAgentkitHumanApprovalRequestConfig({
          pluginConfig,
          env: process.env,
        });
      } catch (error) {
        return {
          block: true,
          blockReason:
            error instanceof Error ? error.message : "World human approval is not configured.",
        };
      }
    }

    const appliedGrant = applyAgentkitHitlGrant({
      appConfig,
      pluginConfig,
      scope: resolveGrantScope(ctx),
    });
    if (appliedGrant) {
      api.logger.info(
        `agentkit: allowed ${ctx.toolName} via ${appliedGrant.grant.decision} grant (${pluginConfig.hitl.grantScope} scope)`,
      );
      return undefined;
    }

    return {
      requireApproval: {
        pluginId: "agentkit",
        ...(pluginConfig.hitl.mode === "human-approval"
          ? {
              actions: buildHumanApprovalActionTemplates(pluginConfig),
            }
          : {}),
        title: `World proof required for ${ctx.toolName}`,
        description: buildApprovalDescription({
          toolName: ctx.toolName,
          hitlMode: pluginConfig.hitl.mode,
          resourceUrl: pluginConfig.hitl.resourceUrl,
          grantScope: pluginConfig.hitl.grantScope,
        }),
        severity: pluginConfig.hitl.severity,
        timeoutMs: pluginConfig.hitl.timeoutMs,
        allowedDecisions: ["deny"],
        keepPendingWithoutRoute: true,
      },
    };
  };
}
