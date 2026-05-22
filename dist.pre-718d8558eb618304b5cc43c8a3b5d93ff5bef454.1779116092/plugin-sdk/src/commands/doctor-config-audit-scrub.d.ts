export declare function maybeScrubConfigAuditLog(params: {
    shouldRepair: boolean;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
    doctorFixCommand?: string;
}): Promise<void>;
