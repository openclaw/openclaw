import type { EnvelopeFormatOptions } from "../envelope.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { TemplateContext } from "../templating.js";
type InboundUserContextPrefixOptions = {
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
};
export declare function resolveInboundUserContextPromptJoiner(ctx: TemplateContext): " " | undefined;
export declare function buildInboundMetaSystemPrompt(ctx: TemplateContext, options?: {
    includeFormattingHints?: boolean;
}): string;
export declare function buildInboundUserContextPrefix(ctx: TemplateContext, envelope?: EnvelopeFormatOptions, options?: InboundUserContextPrefixOptions): string;
export {};
