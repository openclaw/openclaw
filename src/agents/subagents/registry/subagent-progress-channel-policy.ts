import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isChannelAccountExplicitlyDisabled } from "../../../channels/account-config-enabled.js";
import type { getChannelPlugin } from "../../../channels/plugins/index.js";
import { resolveChannelPreviewStreamMode } from "../../../channels/streaming.js";
import { mergeAccountConfig } from "../../../config/channel-account-config.js";
import { resolveChannelConfigRecord } from "../../../config/channel-config-activation.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { resolveChannelAccountEntry } from "../../../routing/account-lookup.js";

/** Capture presentation preference, not channel authority; recheck policy before each effect. */
export function captureSubagentProgressChannelPolicy(params: {
  channel: string;
  accountId: string;
  plugin: NonNullable<ReturnType<typeof getChannelPlugin>>;
}) {
  const { channel, accountId, plugin } = params;
  const readStreamingEntry = () => {
    const root = resolveChannelConfigRecord(getRuntimeConfig(), channel);
    const accounts = asOptionalRecord(root?.accounts);
    const account = asOptionalRecord(resolveChannelAccountEntry(accounts, accountId, channel));
    return mergeAccountConfig({ channelConfig: root ?? undefined, accountConfig: account });
  };
  const entry = readStreamingEntry();
  const streamingIdentity = JSON.stringify(entry.streaming);
  return {
    entry,
    assertCurrent() {
      const cfg = getRuntimeConfig();
      if (
        isChannelAccountExplicitlyDisabled({ cfg, channel, accountId }) ||
        !plugin.config.listAccountIds(cfg).includes(accountId)
      ) {
        throw new Error("Progress account was disabled");
      }
      const currentStreaming = readStreamingEntry();
      if (
        resolveChannelPreviewStreamMode(currentStreaming, "progress") !== "progress" ||
        JSON.stringify(currentStreaming.streaming) !== streamingIdentity
      ) {
        throw new Error("Progress preference changed");
      }
      const hooks = getGlobalHookRunner();
      if (hooks?.hasHooks("message_sending") || hooks?.hasHooks("reply_payload_sending")) {
        throw new Error("Progress modifier policy changed");
      }
    },
  };
}
