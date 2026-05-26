import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/auto-reply/reply/conversation-label-generator.d.ts
type ConversationLabelParams = {
  userMessage: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  maxLength?: number;
};
declare function generateConversationLabel(params: ConversationLabelParams): Promise<string | null>;
//#endregion
export { generateConversationLabel as n, ConversationLabelParams as t };