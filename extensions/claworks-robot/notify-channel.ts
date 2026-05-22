import {
  resolveNotifyTargets,
  type ClaworksNotifyConfig,
  type ClaworksRuntime,
  type NotifyChannelTarget,
} from "@claworks/runtime";
import type { NotifyFn } from "@claworks/runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type { NotifyChannelTarget, ClaworksNotifyConfig };

export function createChannelNotifier(
  api: OpenClawPluginApi,
  config?: ClaworksNotifyConfig,
  opts?: { getRuntime?: () => ClaworksRuntime | null },
): NotifyFn {
  const staticTargets = config?.targets ?? [];

  return async ({ message, channels, cards }) => {
    const channelIds =
      channels && channels.length > 0
        ? channels
        : config?.default_channel
          ? [config.default_channel]
          : [];

    if (channelIds.length === 0) {
      api.logger.info?.(`[claworks:notify] ${message}`);
      return;
    }

    for (const channelId of channelIds) {
      const runtime = opts?.getRuntime?.();
      const dynamicTargets = runtime ? await resolveNotifyTargets(runtime, channelId) : [];
      const target =
        staticTargets.find((t) => t.channel === channelId) ??
        dynamicTargets.find((t) => t.channel === channelId);
      if (!target?.to) {
        api.logger.warn?.(
          `[claworks:notify] no target configured for channel "${channelId}" — add notify.targets or RobotOwner in ObjectStore`,
        );
        continue;
      }

      const adapter = await api.runtime.channel.outbound.loadAdapter(
        channelId as Parameters<typeof api.runtime.channel.outbound.loadAdapter>[0],
      );

      // 尝试渠道原生富卡片发送（duck-typing：检查 adapter 是否提供 sendCard 扩展）
      const channelCard = cards?.[channelId];
      const adapterExt = adapter as
        | (typeof adapter & { sendCard?: (params: Record<string, unknown>) => Promise<void> })
        | undefined;
      if (channelCard && typeof adapterExt?.sendCard === "function") {
        try {
          await adapterExt.sendCard({
            cfg: api.config,
            to: target.to,
            card: channelCard,
            ...(target.accountId ? { accountId: target.accountId } : {}),
            ...(target.threadId != null ? { threadId: target.threadId } : {}),
          });
          api.logger.info?.(`[claworks:notify] sent rich card to ${channelId}:${target.to}`);
          continue;
        } catch (err) {
          api.logger.warn?.(
            `[claworks:notify] sendCard failed for ${channelId}, falling back to text: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // 纯文本降级
      const send = adapter?.sendText;
      if (!send) {
        api.logger.warn?.(`[claworks:notify] outbound adapter unavailable: ${channelId}`);
        continue;
      }

      try {
        await send({
          cfg: api.config,
          to: target.to,
          text: message,
          ...(target.accountId ? { accountId: target.accountId } : {}),
          ...(target.threadId != null ? { threadId: target.threadId } : {}),
        });
        api.logger.info?.(`[claworks:notify] sent to ${channelId}:${target.to}`);
      } catch (err) {
        api.logger.warn?.(
          `[claworks:notify] failed ${channelId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
}
