type MessageLike = {
    role?: unknown;
    content?: unknown;
    timestamp?: unknown;
};
type EntryLike = {
    id?: unknown;
    type?: unknown;
    message?: unknown;
};
type DuplicateUserMessageOptions = {
    windowMs?: number;
};
export declare function dedupeDuplicateUserMessagesForCompaction<T extends MessageLike>(messages: readonly T[], options?: DuplicateUserMessageOptions): T[];
export declare function collectDuplicateUserMessageEntryIdsForCompaction(entries: readonly EntryLike[], options?: DuplicateUserMessageOptions): Set<string>;
export {};
