export function photoUpdate(params: { updateId: number; messageId: number; caption?: string }) {
  return {
    update_id: params.updateId,
    message: {
      message_id: params.messageId,
      date: 1_736_380_800 + params.messageId,
      chat: { id: 111, type: "private" as const, first_name: "Ada" },
      from: { id: 111, is_bot: false, first_name: "Ada" },
      media_group_id: "album-115325",
      ...(params.caption ? { caption: params.caption } : {}),
      photo: [
        {
          file_id: `photo-${params.messageId}`,
          file_unique_id: `unique-${params.messageId}`,
          width: 100,
          height: 100,
          file_size: 4,
        },
      ],
    },
  };
}

export function forwardedTextUpdate(params: { updateId: number; messageId: number; text: string }) {
  return {
    update_id: params.updateId,
    message: {
      message_id: params.messageId,
      date: 1_736_380_800 + params.messageId,
      chat: { id: 111, type: "private" as const, first_name: "Ada" },
      from: { id: 111, is_bot: false, first_name: "Ada" },
      // forward_origin puts the entry on the forward debounce lane (80ms window).
      forward_origin: {
        type: "user" as const,
        date: 1_736_300_000,
        sender_user: { id: 555, is_bot: false, first_name: "Origin" },
      },
      text: params.text,
    },
  };
}

export function textUpdate(params: { updateId: number; messageId: number; text: string }) {
  return {
    update_id: params.updateId,
    message: {
      message_id: params.messageId,
      date: 1_736_380_800 + params.messageId,
      chat: { id: 111, type: "private" as const, first_name: "Ada" },
      from: { id: 111, is_bot: false, first_name: "Ada" },
      text: params.text,
    },
  };
}
