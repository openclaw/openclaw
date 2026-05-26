import { k as TelegramNetworkConfig } from "./types.channels-C67UBRPK.js";
import { t as BaseProbeResult } from "./types.core-BkmTlRzr.js";
//#region extensions/telegram/src/bot-info.d.ts
type TelegramBotInfo = {
  id: number;
  is_bot: true;
  first_name: string;
  last_name?: string;
  username: string;
  language_code?: string;
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  can_manage_bots: boolean;
  supports_inline_queries: boolean;
  can_connect_to_business: boolean;
  has_main_web_app: boolean;
  has_topics_enabled: boolean;
  allows_users_to_create_topics: boolean;
};
//#endregion
//#region extensions/telegram/src/probe.d.ts
type TelegramProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  bot?: {
    id?: number | null;
    isBot?: boolean | null;
    firstName?: string | null;
    username?: string | null;
    canJoinGroups?: boolean | null;
    canReadAllGroupMessages?: boolean | null;
    canManageBots?: boolean | null;
    supportsInlineQueries?: boolean | null;
    canConnectToBusiness?: boolean | null;
    hasMainWebApp?: boolean | null;
    hasTopicsEnabled?: boolean | null;
    allowsUsersToCreateTopics?: boolean | null;
  };
  botInfo?: TelegramBotInfo;
  webhook?: {
    url?: string | null;
    hasCustomCert?: boolean | null;
  };
};
type TelegramProbeOptions = {
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
  accountId?: string;
  apiRoot?: string;
  includeWebhookInfo?: boolean;
};
declare function resetTelegramProbeFetcherCacheForTests(): void;
declare function probeTelegram(token: string, timeoutMs: number, proxyOrOptions?: string | TelegramProbeOptions): Promise<TelegramProbe>;
//#endregion
export { TelegramBotInfo as a, resetTelegramProbeFetcherCacheForTests as i, TelegramProbeOptions as n, probeTelegram as r, TelegramProbe as t };