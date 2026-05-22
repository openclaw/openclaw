//#region src/interactive/payload.d.ts
type InteractiveButtonStyle = "primary" | "secondary" | "success" | "danger";
type InteractiveReplyButton = {
  label: string;
  value?: string;
  url?: string;
  style?: InteractiveButtonStyle;
};
type InteractiveReplyOption = {
  label: string;
  value: string;
};
type InteractiveReplyTextBlock = {
  type: "text";
  text: string;
};
type InteractiveReplyButtonsBlock = {
  type: "buttons";
  buttons: InteractiveReplyButton[];
};
type InteractiveReplySelectBlock = {
  type: "select";
  placeholder?: string;
  options: InteractiveReplyOption[];
};
type InteractiveReplyBlock = InteractiveReplyTextBlock | InteractiveReplyButtonsBlock | InteractiveReplySelectBlock;
type InteractiveReply = {
  blocks: InteractiveReplyBlock[];
};
type MessagePresentationTone = "info" | "success" | "warning" | "danger" | "neutral";
type MessagePresentationButtonStyle = InteractiveButtonStyle;
type MessagePresentationButton = InteractiveReplyButton;
type MessagePresentationOption = InteractiveReplyOption;
type MessagePresentationTextBlock = {
  type: "text";
  text: string;
};
type MessagePresentationContextBlock = {
  type: "context";
  text: string;
};
type MessagePresentationDividerBlock = {
  type: "divider";
};
type MessagePresentationButtonsBlock = {
  type: "buttons";
  buttons: MessagePresentationButton[];
};
type MessagePresentationSelectBlock = {
  type: "select";
  placeholder?: string;
  options: MessagePresentationOption[];
};
type MessagePresentationInteractiveBlock = MessagePresentationButtonsBlock | MessagePresentationSelectBlock;
type MessagePresentationBlock = MessagePresentationTextBlock | MessagePresentationContextBlock | MessagePresentationDividerBlock | MessagePresentationButtonsBlock | MessagePresentationSelectBlock;
type MessagePresentation = {
  title?: string;
  tone?: MessagePresentationTone;
  blocks: MessagePresentationBlock[];
};
type ReplyPayloadDeliveryPin = {
  enabled: boolean;
  notify?: boolean;
  required?: boolean;
};
type ReplyPayloadDelivery = {
  pin?: boolean | ReplyPayloadDeliveryPin;
};
declare function normalizeInteractiveReply(raw: unknown): InteractiveReply | undefined;
declare function normalizeMessagePresentation(raw: unknown): MessagePresentation | undefined;
declare function hasInteractiveReplyBlocks(value: unknown): value is InteractiveReply;
declare function hasMessagePresentationBlocks(value: unknown): value is MessagePresentation;
declare function presentationToInteractiveReply(presentation: MessagePresentation): InteractiveReply | undefined;
declare function isMessagePresentationInteractiveBlock(block: MessagePresentationBlock): block is MessagePresentationInteractiveBlock;
declare function presentationToInteractiveControlsReply(presentation: MessagePresentation): InteractiveReply | undefined;
declare function interactiveReplyToPresentation(interactive: InteractiveReply): MessagePresentation | undefined;
declare function renderMessagePresentationFallbackText(params: {
  presentation?: MessagePresentation;
  emptyFallback?: string | null;
  text?: string | null;
}): string;
declare function hasReplyChannelData(value: unknown): value is Record<string, unknown>;
declare function hasReplyContent(params: {
  text?: string | null;
  mediaUrl?: string | null;
  mediaUrls?: ReadonlyArray<string | null | undefined>;
  interactive?: unknown;
  presentation?: unknown;
  hasChannelData?: boolean;
  extraContent?: boolean;
}): boolean;
declare function resolveInteractiveTextFallback(params: {
  text?: string;
  interactive?: InteractiveReply;
}): string | undefined;
//#endregion
export { presentationToInteractiveControlsReply as A, hasMessagePresentationBlocks as C, isMessagePresentationInteractiveBlock as D, interactiveReplyToPresentation as E, renderMessagePresentationFallbackText as M, resolveInteractiveTextFallback as N, normalizeInteractiveReply as O, hasInteractiveReplyBlocks as S, hasReplyContent as T, MessagePresentationSelectBlock as _, InteractiveReplyOption as a, ReplyPayloadDelivery as b, MessagePresentation as c, MessagePresentationButtonStyle as d, MessagePresentationButtonsBlock as f, MessagePresentationOption as g, MessagePresentationInteractiveBlock as h, InteractiveReplyButton as i, presentationToInteractiveReply as j, normalizeMessagePresentation as k, MessagePresentationBlock as l, MessagePresentationDividerBlock as m, InteractiveReply as n, InteractiveReplySelectBlock as o, MessagePresentationContextBlock as p, InteractiveReplyBlock as r, InteractiveReplyTextBlock as s, InteractiveButtonStyle as t, MessagePresentationButton as u, MessagePresentationTextBlock as v, hasReplyChannelData as w, ReplyPayloadDeliveryPin as x, MessagePresentationTone as y };