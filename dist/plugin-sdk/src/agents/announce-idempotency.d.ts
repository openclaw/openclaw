type AnnounceIdFromChildRunParams = {
    childSessionKey: string;
    childRunId: string;
};
export declare function buildAnnounceIdFromChildRun(params: AnnounceIdFromChildRunParams): string;
export declare function buildAnnounceIdempotencyKey(announceId: string): string;
export {};
