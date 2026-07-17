import type { ChannelMessageToolDiscovery } from "openclaw/plugin-sdk/channel-contract";
import { Type } from "typebox";
// Whatsapp plugin module implements channel actions behavior.
import {
  listWhatsAppAccountIds,
  resolveWhatsAppAccount,
  createActionGate,
  type ChannelMessageActionName,
  type OpenClawConfig,
  resolveWhatsAppReactionLevel,
} from "./channel-actions.runtime.js";

function areWhatsAppAgentReactionsEnabled(params: { cfg: OpenClawConfig; accountId?: string }) {
  if (!params.cfg.channels?.whatsapp) {
    return false;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return false;
  }
  return resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  }).agentReactionsEnabled;
}

function hasAnyWhatsAppAccountWithAgentReactionsEnabled(cfg: OpenClawConfig) {
  if (!cfg.channels?.whatsapp) {
    return false;
  }
  return listWhatsAppAccountIds(cfg).some((accountId) => {
    const account = resolveWhatsAppAccount({ cfg, accountId });
    if (!account.enabled) {
      return false;
    }
    return areWhatsAppAgentReactionsEnabled({
      cfg,
      accountId,
    });
  });
}

export function resolveWhatsAppAgentReactionGuidance(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}) {
  if (!params.cfg.channels?.whatsapp) {
    return undefined;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return undefined;
  }
  const resolved = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!resolved.agentReactionsEnabled) {
    return undefined;
  }
  return resolved.agentReactionGuidance;
}

export function describeWhatsAppMessageActions(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderIsOwner?: boolean;
}): ChannelMessageToolDiscovery | null {
  if (!params.cfg.channels?.whatsapp) {
    return null;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  const actions = new Set<ChannelMessageActionName>();
  const canReact =
    params.accountId != null
      ? areWhatsAppAgentReactionsEnabled({
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
      : hasAnyWhatsAppAccountWithAgentReactionsEnabled(params.cfg);
  if (canReact) {
    actions.add("react");
  }
  if (gate("polls")) {
    actions.add("poll");
  }
  actions.add("upload-file");
  if (params.senderIsOwner && gate("status", false)) {
    actions.add("post-status");
  }
  return {
    actions: Array.from(actions),
    ...(actions.has("post-status")
      ? {
          schema: {
            actions: ["post-status"] as const,
            visibility: "all-configured" as const,
            properties: {
              // The shared message tool uses one flat schema for every advertised action.
              // Keep action-conditional fields optional here and enforce them in the handler.
              audience: Type.Optional(
                Type.Array(Type.String(), {
                  minItems: 1,
                  description:
                    "Required for post-status: explicit allowlisted E.164 numbers or JIDs.",
                }),
              ),
              backgroundColor: Type.Optional(
                Type.String({ description: "Optional text Status background color." }),
              ),
              font: Type.Optional(
                Type.Integer({
                  minimum: 0,
                  description: "Optional WhatsApp text Status font number.",
                }),
              ),
            },
          },
        }
      : {}),
  };
}
