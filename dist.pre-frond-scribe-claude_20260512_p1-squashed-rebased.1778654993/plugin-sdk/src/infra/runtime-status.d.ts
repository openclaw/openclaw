type RuntimeStatusFormatInput = {
    status?: string;
    pid?: number;
    state?: string;
    details?: string[];
};
export declare function formatRuntimeStatusWithDetails({ status, pid, state, details, }: RuntimeStatusFormatInput): string;
export {};
