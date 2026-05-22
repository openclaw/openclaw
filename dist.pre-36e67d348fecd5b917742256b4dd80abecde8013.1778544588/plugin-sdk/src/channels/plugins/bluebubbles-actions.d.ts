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
