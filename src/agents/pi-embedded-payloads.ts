export type BlockReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
};
