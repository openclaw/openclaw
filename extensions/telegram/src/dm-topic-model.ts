import { buildModelAliasIndex, resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveChannelModelOverride } from "openclaw/plugin-sdk/model-session-runtime";

/** What the next reply in an unpinned DM topic runs on: the channel's model, else the agent default. */
export function resolveTelegramUnpinnedTopicModel(
  params: { cfg: OpenClawConfig; agentId: string; chatId?: string },
  defaultModel: { provider: string; model: string },
): { provider: string; model: string } {
  const channelModel = resolveChannelModelOverride({
    cfg: params.cfg,
    channel: "telegram",
    groupChatType: "direct",
    directUserIds: [params.chatId],
  });
  const selectionContext = {
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: defaultModel.provider,
  };
  const channelRef = channelModel
    ? resolveModelRefFromString({
        ...selectionContext,
        raw: channelModel.model,
        aliasIndex: buildModelAliasIndex(selectionContext),
      })?.ref
    : undefined;
  return channelRef ?? { provider: defaultModel.provider, model: defaultModel.model };
}
