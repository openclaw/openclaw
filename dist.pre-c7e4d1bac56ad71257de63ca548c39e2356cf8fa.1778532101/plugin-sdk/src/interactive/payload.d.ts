export type InteractiveButtonStyle = "primary" | "secondary" | "success" | "danger";
export type InteractiveReplyButton = {
    label: string;
    value?: string;
    url?: string;
    style?: InteractiveButtonStyle;
};
export type InteractiveReplyOption = {
    label: string;
    value: string;
};
export type InteractiveReplyTextBlock = {
    type: "text";
    text: string;
};
type InteractiveReplyButtonsBlock = {
    type: "buttons";
    buttons: InteractiveReplyButton[];
};
export type InteractiveReplySelectBlock = {
    type: "select";
    placeholder?: string;
    options: InteractiveReplyOption[];
};
export type InteractiveReplyBlock = InteractiveReplyTextBlock | InteractiveReplyButtonsBlock | InteractiveReplySelectBlock;
export type InteractiveReply = {
    blocks: InteractiveReplyBlock[];
};
export type MessagePresentationTone = "info" | "success" | "warning" | "danger" | "neutral";
export type MessagePresentationButtonStyle = InteractiveButtonStyle;
export type MessagePresentationButton = InteractiveReplyButton;
export type MessagePresentationOption = InteractiveReplyOption;
export type MessagePresentationTextBlock = {
    type: "text";
    text: string;
};
export type MessagePresentationContextBlock = {
    type: "context";
    text: string;
};
export type MessagePresentationDividerBlock = {
    type: "divider";
};
export type MessagePresentationButtonsBlock = {
    type: "buttons";
    buttons: MessagePresentationButton[];
};
export type MessagePresentationSelectBlock = {
    type: "select";
    placeholder?: string;
    options: MessagePresentationOption[];
};
export type MessagePresentationBlock = MessagePresentationTextBlock | MessagePresentationContextBlock | MessagePresentationDividerBlock | MessagePresentationButtonsBlock | MessagePresentationSelectBlock;
export type MessagePresentation = {
    title?: string;
    tone?: MessagePresentationTone;
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
export declare function normalizeInteractiveReply(raw: unknown): InteractiveReply | undefined;
export declare function normalizeMessagePresentation(raw: unknown): MessagePresentation | undefined;
export declare function hasInteractiveReplyBlocks(value: unknown): value is InteractiveReply;
export declare function hasMessagePresentationBlocks(value: unknown): value is MessagePresentation;
export declare function presentationToInteractiveReply(presentation: MessagePresentation): InteractiveReply | undefined;
export declare function interactiveReplyToPresentation(interactive: InteractiveReply): MessagePresentation | undefined;
export declare function renderMessagePresentationFallbackText(params: {
    presentation?: MessagePresentation;
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
export declare function resolveInteractiveTextFallback(params: {
    text?: string;
    interactive?: InteractiveReply;
}): string | undefined;
export {};
