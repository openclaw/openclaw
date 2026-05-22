type ApproverInput = string | number;
export declare function resolveApprovalApprovers(params: {
    explicit?: readonly ApproverInput[] | null;
    allowFrom?: readonly ApproverInput[] | null;
    extraAllowFrom?: readonly ApproverInput[] | null;
    defaultTo?: string | null;
    normalizeApprover: (value: ApproverInput) => string | undefined;
    normalizeDefaultTo?: (value: string) => string | undefined;
}): string[];
export {};
