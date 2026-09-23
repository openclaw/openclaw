import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Discord plugin module implements runtime.messaging behavior.
import { readDiscordComponentSpec } from "../components.js";
import { sendDiscordComponentMessage } from "../send.components.js";
import { resolveDiscordTargetChannelId } from "../send.shared.js";
import { resolveDiscordChannelId } from "../targets.js";

export { readDiscordComponentSpec, resolveDiscordChannelId, sendDiscordComponentMessage };
export {
  createThreadDiscord,
  deleteMessageDiscord,
  editMessageDiscord,
  editChannelDiscord,
  fetchChannelInfoDiscord,
  fetchGuildInfoDiscord,
  fetchChannelPermissionsDiscord,
  fetchMessageDiscord,
  fetchReactionsDiscord,
  listPinsDiscord,
  listThreadsDiscord,
  pinMessageDiscord,
  reactMessageDiscord,
  readMessagesDiscord,
  removeOwnReactionsDiscord,
  removeReactionDiscord,
  searchMessagesDiscord,
  sendMessageDiscord,
  sendStickerDiscord,
  sendVoiceMessageDiscord,
  unpinMessageDiscord,
} from "../send.js";

export async function resolveDiscordReactionTargetChannelId(params: {
  target: string;
  cfg: OpenClawConfig;
  accountId?: string;
}): Promise<string> {
  try {
    return resolveDiscordChannelId(params.target);
  } catch {
    return (
      await resolveDiscordTargetChannelId(params.target, {
        cfg: params.cfg,
        accountId: params.accountId,
      })
    ).channelId;
  }
}
