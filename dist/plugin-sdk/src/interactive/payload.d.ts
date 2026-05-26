export type InteractiveButtonStyle = "primary" | "secondary" | "success" | "danger";
/** Visual tone for a portable message presentation. */
export type MessagePresentationTone = "info" | "success" | "warning" | "danger" | "neutral";
/** Button style hint for renderers that support styled actions. */
export type MessagePresentationButtonStyle = InteractiveButtonStyle;
/** Portable action control rendered as a button or link by channel adapters. */
export type MessagePresentationButton = {
    /** User-visible button label. */
    label: string;
    /** Callback command or opaque value sent when the button is pressed. */
    value?: string;
    /** External URL opened by the button instead of sending a callback value. */
    url?: string;
    /** Telegram-style web app launch target. */
    webApp?: {
        url: string;
    };
    /**
     * @deprecated Use webApp. The snake_case alias is accepted for legacy JSON payloads only.
     */
    web_app?: {
        url: string;
    };
    /** Higher-priority buttons are kept first when channel limits require truncation. */
    priority?: number;
    /** Disable the button when the target channel supports disabled controls. */
    disabled?: boolean;
    /** Keep this action available after a successful interaction when the target channel supports it. */
    reusable?: boolean;
    /** Optional visual style hint; unsupported channels ignore or normalize it. */
    style?: InteractiveButtonStyle;
};
/** Portable select/menu option. */
export type MessagePresentationOption = {
    /** User-visible option label. */
    label: string;
    /** Callback command or opaque value sent when the option is selected. */
    value: string;
};
/**
 * @deprecated Use MessagePresentationButton.
 */
export type InteractiveReplyButton = MessagePresentationButton;
/**
 * @deprecated Use MessagePresentationOption.
 */
export type InteractiveReplyOption = MessagePresentationOption;
/**
 * @deprecated Use MessagePresentationTextBlock.
 */
export type InteractiveReplyTextBlock = {
    type: "text";
    text: string;
};
/**
 * @deprecated Use MessagePresentationButtonsBlock.
 */
type InteractiveReplyButtonsBlock = {
    type: "buttons";
    buttons: InteractiveReplyButton[];
};
/**
 * @deprecated Use MessagePresentationSelectBlock.
 */
export type InteractiveReplySelectBlock = {
    type: "select";
    placeholder?: string;
    options: InteractiveReplyOption[];
};
/**
 * @deprecated Use MessagePresentationBlock.
 */
export type InteractiveReplyBlock = InteractiveReplyTextBlock | InteractiveReplyButtonsBlock | InteractiveReplySelectBlock;
/**
 * @deprecated Use MessagePresentation.
 */
export type InteractiveReply = {
    blocks: InteractiveReplyBlock[];
};
export type MessagePresentationTextBlock = {
    type: "text";
    /** Primary markdown-ish text rendered in the message body. */
    text: string;
};
export type MessagePresentationContextBlock = {
    type: "context";
    /** Lower-emphasis contextual text, or normal text on channels without context support. */
    text: string;
};
export type MessagePresentationDividerBlock = {
    type: "divider";
};
export type MessagePresentationButtonsBlock = {
    type: "buttons";
    /** Button row candidates; core may split or truncate them for channel limits. */
    buttons: MessagePresentationButton[];
};
export type MessagePresentationSelectBlock = {
    type: "select";
    /** Optional prompt shown above or inside the select control. */
    placeholder?: string;
    /** Menu options; core may truncate them for channel limits. */
    options: MessagePresentationOption[];
};
export type MessagePresentationInteractiveBlock = MessagePresentationButtonsBlock | MessagePresentationSelectBlock;
export type MessagePresentationBlock = MessagePresentationTextBlock | MessagePresentationContextBlock | MessagePresentationDividerBlock | MessagePresentationButtonsBlock | MessagePresentationSelectBlock;
export type MessagePresentation = {
    /** Optional short heading rendered before blocks when the channel supports it. */
    title?: string;
    /** Optional severity/status tone for renderers that support toned presentations. */
    tone?: MessagePresentationTone;
    /** Ordered portable blocks rendered or downgraded by the target channel adapter. */
    blocks: MessagePresentationBlock[];
};
export type ReplyPayloadDeliveryPin = {
    enabled: boolean;
    notify?: boolean;
    required?: boolean;
};
export type ReplyPayloadDelivery = {
    pin?: boolean | ReplyPayloadDeliveryPin;
};
/**
 * @deprecated Use normalizeMessagePresentation.
 */
export declare function normalizeInteractiveReply(raw: unknown): InteractiveReply | undefined;
export declare function normalizeMessagePresentation(raw: unknown): MessagePresentation | undefined;
/**
 * @deprecated Use hasMessagePresentationBlocks.
 */
export declare function hasInteractiveReplyBlocks(value: unknown): value is InteractiveReply;
export declare function hasMessagePresentationBlocks(value: unknown): value is MessagePresentation;
/**
 * @deprecated Avoid producing InteractiveReply payloads; send MessagePresentation directly.
 */
export declare function presentationToInteractiveReply(presentation: MessagePresentation): InteractiveReply | undefined;
export declare function isMessagePresentationInteractiveBlock(block: MessagePresentationBlock): block is MessagePresentationInteractiveBlock;
/**
 * @deprecated Avoid producing InteractiveReply payloads; send MessagePresentation directly.
 */
export declare function presentationToInteractiveControlsReply(presentation: MessagePresentation): InteractiveReply | undefined;
/**
 * @deprecated Legacy bridge for old InteractiveReply payloads. New producers should send MessagePresentation.
 */
export declare function interactiveReplyToPresentation(interactive: InteractiveReply): MessagePresentation | undefined;
export declare function renderMessagePresentationFallbackText(params: {
    presentation?: MessagePresentation;
    emptyFallback?: string | null;
    text?: string | null;
}): string;
export declare function hasReplyChannelData(value: unknown): value is Record<string, unknown>;
export declare function hasReplyContent(params: {
    text?: string | null;
    mediaUrl?: string | null;
    mediaUrls?: ReadonlyArray<string | null | undefined>;
    interactive?: unknown;
    presentation?: unknown;
    hasChannelData?: boolean;
    extraContent?: boolean;
}): boolean;
export declare function hasReplyPayloadContent(payload: {
    text?: string | null;
    mediaUrl?: string | null;
    mediaUrls?: ReadonlyArray<string | null | undefined>;
    interactive?: unknown;
    presentation?: unknown;
    channelData?: unknown;
}, options?: {
    trimText?: boolean;
    hasChannelData?: boolean;
    extraContent?: boolean;
}): boolean;
/**
 * @deprecated Use renderMessagePresentationFallbackText with MessagePresentation.
 */
export declare function resolveInteractiveTextFallback(params: {
    text?: string;
    interactive?: InteractiveReply;
}): string | undefined;
export {};
