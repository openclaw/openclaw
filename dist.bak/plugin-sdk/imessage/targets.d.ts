export type IMessageService = "imessage" | "sms" | "auto";
export type IMessageTarget = {
    kind: "chat_id";
    chatId: number;
} | {
    kind: "chat_guid";
    chatGuid: string;
} | {
    kind: "chat_identifier";
    chatIdentifier: string;
} | {
    kind: "handle";
    to: string;
    service: IMessageService;
};
export type IMessageAllowTarget = {
    kind: "chat_id";
    chatId: number;
} | {
    kind: "chat_guid";
    chatGuid: string;
} | {
    kind: "chat_identifier";
    chatIdentifier: string;
} | {
    kind: "handle";
    handle: string;
};
export declare function normalizeIMessageHandle(raw: string): string;
export declare function parseIMessageTarget(raw: string): IMessageTarget;
export declare function parseIMessageAllowTarget(raw: string): IMessageAllowTarget;
export declare function isAllowedIMessageSender(params: {
    allowFrom: Array<string | number>;
    sender: string;
    chatId?: number | null;
    chatGuid?: string | null;
    chatIdentifier?: string | null;
}): boolean;
export declare function formatIMessageChatTarget(chatId?: number | null): string;
