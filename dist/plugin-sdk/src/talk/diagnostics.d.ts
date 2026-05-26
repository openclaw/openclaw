import { type DiagnosticEventInput } from "../infra/diagnostic-events.js";
import type { TalkEvent } from "./talk-events.js";
type TalkDiagnosticEventInput = Extract<DiagnosticEventInput, {
    type: "talk.event";
}>;
export declare function createTalkDiagnosticEvent(event: TalkEvent): TalkDiagnosticEventInput;
export declare function recordTalkDiagnosticEvent(event: TalkEvent): void;
export {};
