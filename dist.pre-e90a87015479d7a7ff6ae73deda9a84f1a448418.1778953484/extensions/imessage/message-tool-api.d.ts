import { y as ChannelMessageActionAdapter } from "../../types.core-yC1NCFUF.js";
//#region extensions/imessage/src/message-tool-api.d.ts
declare function describeIMessageMessageTool({
  cfg,
  accountId,
  currentChannelId
}: Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0]): {
  actions: ("permissions" | "timeout" | "search" | "reply" | "read" | "poll" | "broadcast" | "reactions" | "sticker" | "edit" | "unsend" | "sendWithEffect" | "renameGroup" | "setGroupIcon" | "addParticipant" | "removeParticipant" | "leaveGroup" | "sendAttachment" | "send" | "poll-vote" | "react" | "delete" | "pin" | "unpin" | "list-pins" | "thread-create" | "thread-list" | "thread-reply" | "sticker-search" | "member-info" | "role-info" | "emoji-list" | "emoji-upload" | "sticker-upload" | "role-add" | "role-remove" | "channel-info" | "channel-list" | "channel-create" | "channel-edit" | "channel-delete" | "channel-move" | "category-create" | "category-edit" | "category-delete" | "topic-create" | "topic-edit" | "voice-status" | "event-list" | "event-create" | "kick" | "ban" | "set-profile" | "set-presence" | "download-file" | "upload-file")[];
} | null;
//#endregion
export { describeIMessageMessageTool as describeMessageTool };