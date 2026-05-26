export type InvalidPersistedCronJobReason = "missing-id" | "missing-schedule" | "invalid-schedule" | "missing-payload" | "invalid-payload";
export declare function getInvalidPersistedCronJobReason(candidate: Record<string, unknown>): InvalidPersistedCronJobReason | null;
