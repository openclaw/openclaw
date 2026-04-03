/**
 * WeCom 类型统一导出
 */

// 常量
export * from "./constants.js";

// 配置类型（仅导出被使用的子模块类型）
export type {
    WecomMediaConfig,
    WecomNetworkConfig,
    WecomBotConfig,
    WecomAgentConfig,
} from "./config.js";

// 账号类型
export type {
    ResolvedAgentAccount,
} from "./account.js";

// 消息类型
export type {
    WecomBotInboundBase,
    WecomBotInboundText,
    WecomBotInboundVoice,
    WecomBotInboundVideo,
    WecomBotInboundStreamRefresh,
    WecomBotInboundEvent,
    WecomBotInboundMessage,
    WecomAgentInboundMessage,
    WecomInboundQuote,
    WecomTemplateCard,
    WecomOutboundMessage,
} from "./message.js";
