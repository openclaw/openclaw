export declare function hasLegacyDeliveryHints(payload: Record<string, unknown>): boolean;
export declare function buildDeliveryFromLegacyPayload(payload: Record<string, unknown>): Record<string, unknown>;
export declare function buildDeliveryPatchFromLegacyPayload(payload: Record<string, unknown>): Record<string, unknown> | null;
export declare function mergeLegacyDeliveryInto(delivery: Record<string, unknown>, payload: Record<string, unknown>): {
    delivery: Record<string, unknown>;
    mutated: boolean;
};
export declare function normalizeLegacyDeliveryInput(params: {
    delivery?: Record<string, unknown> | null;
    payload?: Record<string, unknown> | null;
}): {
    delivery: Record<string, unknown> | undefined;
    mutated: boolean;
};
