//#region src/channels/ack-reactions.d.ts
type AckReactionScope = "all" | "direct" | "group-all" | "group-mentions" | "off" | "none";
type WhatsAppAckReactionMode = "always" | "mentions" | "never";
type AckReactionHandle = {
  ackReactionPromise: Promise<boolean>;
  ackReactionValue: string;
  remove: () => Promise<void>;
};
type AckReactionGateParams = {
  scope: AckReactionScope | undefined;
  isDirect: boolean;
  isGroup: boolean;
  isMentionableGroup: boolean;
  requireMention: boolean;
  canDetectMention: boolean;
  effectiveWasMentioned: boolean;
  shouldBypassMention?: boolean;
};
declare function shouldAckReaction(params: AckReactionGateParams): boolean;
declare function shouldAckReactionForWhatsApp(params: {
  emoji: string;
  isDirect: boolean;
  isGroup: boolean;
  directEnabled: boolean;
  groupMode: WhatsAppAckReactionMode;
  wasMentioned: boolean;
  groupActivated: boolean;
}): boolean;
declare function createAckReactionHandle(params: {
  ackReactionValue: string;
  send: () => Promise<void>;
  remove: () => Promise<void>;
  onSendError?: (err: unknown) => void;
}): AckReactionHandle | null;
declare function removeAckReactionAfterReply(params: {
  removeAfterReply: boolean;
  ackReactionPromise: Promise<boolean> | null;
  ackReactionValue: string | null;
  remove: () => Promise<void>;
  onError?: (err: unknown) => void;
}): void;
declare function removeAckReactionHandleAfterReply(params: {
  removeAfterReply: boolean;
  ackReaction: AckReactionHandle | null | undefined;
  onError?: (err: unknown) => void;
}): void;
//#endregion
export { createAckReactionHandle as a, shouldAckReaction as c, WhatsAppAckReactionMode as i, shouldAckReactionForWhatsApp as l, AckReactionHandle as n, removeAckReactionAfterReply as o, AckReactionScope as r, removeAckReactionHandleAfterReply as s, AckReactionGateParams as t };