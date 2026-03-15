import type { MatrixRoomConfig, ReplyToMode } from "../../types.js";

export type ThreadRepliesMode = "off" | "inbound" | "always";

export function resolveMatrixReplyOptions(params: {
  isRoom: boolean;
  roomConfig?: MatrixRoomConfig;
  globalReplyToMode: ReplyToMode;
  globalThreadReplies: ThreadRepliesMode;
}): { replyToMode: ReplyToMode; threadReplies: ThreadRepliesMode } {
  const { isRoom, roomConfig, globalReplyToMode, globalThreadReplies } = params;
  if (!isRoom || !roomConfig) {
    return { replyToMode: globalReplyToMode, threadReplies: globalThreadReplies };
  }

  return {
    replyToMode: roomConfig.replyToMode ?? globalReplyToMode,
    threadReplies: roomConfig.threadReplies ?? globalThreadReplies,
  };
}
