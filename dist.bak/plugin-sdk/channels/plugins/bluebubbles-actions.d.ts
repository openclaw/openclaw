export type BlueBubblesActionSpec = {
    gate: string;
    groupOnly?: boolean;
    unsupportedOnMacOS26?: boolean;
};
export declare const BLUEBUBBLES_ACTIONS: {
    readonly react: {
        readonly gate: "reactions";
    };
    readonly edit: {
        readonly gate: "edit";
        readonly unsupportedOnMacOS26: true;
    };
    readonly unsend: {
        readonly gate: "unsend";
    };
    readonly reply: {
        readonly gate: "reply";
    };
    readonly sendWithEffect: {
        readonly gate: "sendWithEffect";
    };
    readonly renameGroup: {
        readonly gate: "renameGroup";
        readonly groupOnly: true;
    };
    readonly setGroupIcon: {
        readonly gate: "setGroupIcon";
        readonly groupOnly: true;
    };
    readonly addParticipant: {
        readonly gate: "addParticipant";
        readonly groupOnly: true;
    };
    readonly removeParticipant: {
        readonly gate: "removeParticipant";
        readonly groupOnly: true;
    };
    readonly leaveGroup: {
        readonly gate: "leaveGroup";
        readonly groupOnly: true;
    };
    readonly sendAttachment: {
        readonly gate: "sendAttachment";
    };
};
export declare const BLUEBUBBLES_ACTION_NAMES: (keyof typeof BLUEBUBBLES_ACTIONS)[];
export declare const BLUEBUBBLES_GROUP_ACTIONS: Set<"send" | "broadcast" | "poll" | "react" | "reactions" | "read" | "edit" | "unsend" | "reply" | "sendWithEffect" | "renameGroup" | "setGroupIcon" | "addParticipant" | "removeParticipant" | "leaveGroup" | "sendAttachment" | "delete" | "pin" | "unpin" | "list-pins" | "permissions" | "thread-create" | "thread-list" | "thread-reply" | "search" | "sticker" | "sticker-search" | "member-info" | "role-info" | "emoji-list" | "emoji-upload" | "sticker-upload" | "role-add" | "role-remove" | "channel-info" | "channel-list" | "channel-create" | "channel-edit" | "channel-delete" | "channel-move" | "category-create" | "category-edit" | "category-delete" | "topic-create" | "voice-status" | "event-list" | "event-create" | "timeout" | "kick" | "ban" | "set-presence">;
