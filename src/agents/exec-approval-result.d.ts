export type ExecApprovalResult = {
    kind: "denied";
    raw: string;
    metadata: string;
    body: string;
} | {
    kind: "finished";
    raw: string;
    metadata: string;
    body: string;
} | {
    kind: "completed";
    raw: string;
    body: string;
} | {
    kind: "other";
    raw: string;
};
export declare function parseExecApprovalResultText(resultText: string): ExecApprovalResult;
export declare function isExecDeniedResultText(resultText: string): boolean;
export declare function formatExecDeniedUserMessage(resultText: string): string | null;
