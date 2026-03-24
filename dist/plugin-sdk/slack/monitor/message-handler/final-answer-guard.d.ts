import type { ReplyPayload } from "../../../auto-reply/types.js";
type SlackEitherOrQuestion = {
    leftOption: string;
    rightOption: string;
};
declare function extractEitherOrQuestion(text?: string): SlackEitherOrQuestion | null;
export declare function enforceSlackDirectEitherOrAnswer(params: {
    questionText?: string;
    payload: ReplyPayload;
}): ReplyPayload;
export declare function shouldRequireSlackDisprovedTheory(params: {
    inboundText?: string;
    incidentRootOnly?: boolean;
    isThreadReply?: boolean;
}): boolean;
export declare function enforceSlackDisprovedTheoryRetraction(params: {
    inboundText?: string;
    incidentRootOnly?: boolean;
    isThreadReply?: boolean;
    payload: ReplyPayload;
}): ReplyPayload;
export { extractEitherOrQuestion };
