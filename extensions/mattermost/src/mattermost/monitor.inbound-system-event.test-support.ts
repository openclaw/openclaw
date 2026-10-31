export function mattermostPostEvent(params: {
  id: string;
  message: string;
  channelId?: string;
  rootId?: string;
  senderId?: string;
  senderName?: string;
  createAt?: number;
  type?: string;
  fileIds?: string[];
  channelType?: string;
  includeChannelLabels?: boolean;
}) {
  const senderId = params.senderId ?? "user-1";
  const channelId = params.channelId ?? "chan-1";
  return {
    event: "posted",
    data: {
      channel_id: channelId,
      ...(params.includeChannelLabels === false
        ? {}
        : { channel_name: "town-square", channel_display_name: "Town Square" }),
      channel_type: params.channelType,
      sender_name: params.senderName ?? "alice",
      post: JSON.stringify({
        id: params.id,
        channel_id: channelId,
        user_id: senderId,
        message: params.message,
        root_id: params.rootId,
        create_at: params.createAt ?? 1_714_000_000_000,
        type: params.type,
        file_ids: params.fileIds,
      }),
    },
    broadcast: {
      channel_id: channelId,
      user_id: senderId,
    },
  };
}
