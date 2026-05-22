export declare const CONTINUATION_DELEGATE_FANOUT_MODES: readonly ["tree", "all"];
export type ContinuationDelegateFanoutMode = (typeof CONTINUATION_DELEGATE_FANOUT_MODES)[number];
export type ContinuationDelegateTargeting = {
    targetSessionKey?: string;
    targetSessionKeys?: readonly string[];
    fanoutMode?: ContinuationDelegateFanoutMode;
};
export declare function normalizeContinuationTargetKey(value?: string): string | undefined;
export declare function normalizeContinuationTargetKeys(values?: readonly string[]): string[];
export declare function hasContinuationDelegateTargeting(targeting: ContinuationDelegateTargeting): boolean;
