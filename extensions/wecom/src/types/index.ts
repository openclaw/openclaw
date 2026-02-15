/**
 * WeCom 类型统一导出
 */

// 常量
export * from "./constants.js";

// 配置类型
export type {
  WecomDmConfig,
  WecomMediaConfig,
  WecomNetworkConfig,
  WecomBotConfig,
  WecomAgentConfig,
  WecomConfig,
} from "./config.js";

// 账号类型
export type {
  ResolvedBotAccount,
  ResolvedAgentAccount,
  ResolvedMode,
  ResolvedWecomAccounts,
} from "./account.js";

// 消息类型
export type {
  WecomBotInboundBase,
  WecomBotInboundText,
  WecomBotInboundVoice,
  WecomBotInboundStreamRefresh,
  WecomBotInboundEvent,
  WecomBotInboundMessage,
  WecomAgentInboundMessage,
  WecomInboundQuote,
  WecomTemplateCard,
  WecomOutboundMessage,
} from "./message.js";
