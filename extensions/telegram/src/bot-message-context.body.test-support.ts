type Message = Record<string, unknown>;

export const GROUP_ID = -1_001_234_567_890;
const FORUM_CHAT = { id: GROUP_ID, type: "supergroup", title: "Test Forum", is_forum: true };

export function photoMessage(messageId: number, id: string, extra: Message = {}): Message {
  return {
    message_id: messageId,
    photo: [{ file_id: id, file_unique_id: `${id}-unique`, width: 120, height: 80 }],
    ...extra,
  };
}

export function stickerMessage(messageId: number, id: string, extra: Message = {}): Message {
  return {
    message_id: messageId,
    sticker: {
      file_id: id,
      file_unique_id: `${id}-unique`,
      type: "regular",
      width: 256,
      height: 256,
      is_animated: false,
      is_video: false,
      ...extra,
    },
  };
}

export function voiceMessage(fileId: string, messageId = 1, extra: Message = {}): Message {
  return {
    message_id: messageId,
    date: 1_700_000_000 + messageId,
    voice: { file_id: fileId },
    entities: [],
    ...extra,
  };
}

export function forumMessage(messageId: number, extra: Message = {}) {
  return {
    message_id: messageId,
    date: 1_700_000_000 + messageId,
    message_thread_id: 99,
    chat: FORUM_CHAT,
    entities: [],
    ...extra,
  };
}
