import type { SourceReplyDeliveryMode } from "../../auto-reply/source-reply-delivery-mode.types.js";

export type CliSessionBindingFacts = {
  extraSystemPromptStatic?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  requireExplicitMessageTarget?: boolean;
};
