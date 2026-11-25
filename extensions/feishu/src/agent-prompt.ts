import type { ChannelMessageToolDiscovery } from "openclaw/plugin-sdk/channel-contract";

export function buildFeishuMessageToolHints(
  actions: ChannelMessageToolDiscovery["actions"],
): string[] {
  return [
    "- Feishu targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:open_id` or `chat:chat_id`.",
    "- Feishu supports interactive cards plus native image, file, audio, and video/media delivery.",
    "- Feishu buttons support command and URL actions. Generic callbacks and `ask_user` choice buttons are not supported; ask questions in plain text.",
    "- Feishu supports `send`, `read`, `edit`, `thread-reply`, pins, and channel/member lookup, plus reactions when enabled.",
    ...(actions?.includes("sticker")
      ? [
          "- Feishu stickers: use `action=sticker` with `fileId` (or the first `stickerId`) from a sticker this bot previously received. Sticker upload is not supported.",
        ]
      : []),
    ...(actions?.includes("sticker-search")
      ? [
          "- Feishu `action=sticker-search`: configured keyword lookup only, not store search or learned/visual matching. Supply `query` (1–128 characters) and optional `limit` (1–10, default 5); send a returned `fileId` with `action=sticker` on the same account. If `truncated` is true, narrow the query.",
        ]
      : []),
  ];
}
