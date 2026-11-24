export const update = () => ({
  update_id: 42,
  message: {
    message_id: 21,
    date: 1_790_000_000,
    from: { id: 111111, is_bot: false, first_name: "Synthetic" },
    chat: { id: 111111, type: "private", first_name: "Synthetic" },
    voice: { file_id: "synthetic-file", file_unique_id: "synthetic-unique", duration: 1 },
  },
});

export const groupUpdate = () => {
  const original = update();
  return {
    ...original,
    message: {
      ...original.message,
      chat: { id: -222, type: "supergroup" as const, title: "Synthetic group", is_forum: false },
    },
  };
};

export function albumUpdates(secondCaption: string) {
  const original = groupUpdate();
  return ["ordinary first", secondCaption].map((caption, index) => ({
    update_id: original.update_id + index,
    message: {
      message_id: original.message.message_id + index,
      date: original.message.date,
      from: original.message.from,
      chat: original.message.chat,
      media_group_id: "synthetic-album",
      photo: [
        { file_id: `photo-${index}`, file_unique_id: `unique-${index}`, width: 1, height: 1 },
      ],
      caption,
      caption_entities:
        caption === "/reset@synthetic_bot"
          ? [{ type: "bot_command" as const, offset: 0, length: caption.length }]
          : [],
    },
  }));
}
