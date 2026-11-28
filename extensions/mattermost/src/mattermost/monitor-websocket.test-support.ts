import { EventEmitter } from "node:events";

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
  };
}

export class FakeWebSocket extends EventEmitter<{
  open: [];
  message: [Buffer];
  pong: [Buffer];
  close: [number, Buffer];
  error: [unknown];
}> {
  send(_data: string): void {}
  ping(): void {}
  close(): void {}
  terminate(): void {
    this.emit("close", 1000, Buffer.alloc(0));
  }
  async emitMessage(payload: unknown): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(payload), "utf8");
    await Promise.all(
      this.listeners("message").map((listener) => Promise.resolve(listener(buffer))),
    );
  }
}
