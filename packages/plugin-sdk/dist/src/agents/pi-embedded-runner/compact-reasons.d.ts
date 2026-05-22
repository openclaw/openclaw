export declare function resolveCompactionFailureReason(params: {
    reason: string;
    safeguardCancelReason?: string | null;
}): string;
export declare function classifyCompactionReason(reason?: string): string;
export declare function formatUnknownCompactionReasonDetail(reason?: string): string | undefined;
