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

  return async ({ message, channels }) => {
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
