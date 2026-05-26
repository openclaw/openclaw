type TranscriptRepairResult = {
    filePath: string;
    broken: boolean;
    repaired: boolean;
    originalEntries: number;
    activeEntries: number;
    backupPath?: string;
    reason?: string;
};
export declare function repairBrokenSessionTranscriptFile(params: {
    filePath: string;
    shouldRepair: boolean;
}): Promise<TranscriptRepairResult>;
export declare function noteSessionTranscriptHealth(params?: {
    shouldRepair?: boolean;
    sessionDirs?: string[];
}): Promise<void>;
export {};
