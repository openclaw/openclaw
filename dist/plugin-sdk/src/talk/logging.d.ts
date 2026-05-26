import type { TalkEvent } from "./talk-events.js";
type TalkLogLevel = "info" | "warn";
type TalkLogRecord = {
    level: TalkLogLevel;
    message: string;
    attributes: Record<string, string | number | boolean>;
};
export declare function createTalkLogRecord(event: TalkEvent): TalkLogRecord | undefined;
export declare function recordTalkLogEvent(event: TalkEvent): void;
export {};
