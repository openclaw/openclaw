import { buildModelAliasIndex, resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveChannelModelOverride } from "openclaw/plugin-sdk/model-session-runtime";

// A private topic keeps its peer's channel default without inheriting the flat DM's pin.
export function resolveTelegramDmModelDefault(params: {
  cfg: OpenClawConfig;
  agentId: string;
  chatId: string | number;
  senderId?: string | number;
  defaultModel: { provider: string; model: string };
}): { provider: string; model: string } {
  const override = resolveChannelModelOverride({
    cfg: params.cfg,
    channel: "telegram",
    groupChatType: "direct",
    parentSessionKey: null,
    directUserIds: [`telegram:${params.chatId}`, params.senderId?.toString()],
  });
  if (!override) {
    return params.defaultModel;
  }
  const modelParams = {
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: params.defaultModel.provider,
  };
  return (
    resolveModelRefFromString({
      ...modelParams,
      raw: override.model,
      aliasIndex: buildModelAliasIndex(modelParams),
    })?.ref ?? params.defaultModel
  );
}
