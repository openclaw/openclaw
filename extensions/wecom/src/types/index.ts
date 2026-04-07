/**
 * WeCom types unified export
 */

// Constants
export * from "./constants.js";

// Configuration types (only export used sub-module types)
export type {
  WecomMediaConfig,
  WecomNetworkConfig,
  WecomBotConfig,
  WecomAgentConfig,
} from "./config.js";

// Account types
export type { ResolvedAgentAccount } from "./account.js";

// Message types
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
