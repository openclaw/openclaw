type RepairReport = {
    repaired: boolean;
    droppedLines: number;
    backupPath?: string;
    reason?: string;
};
export declare function repairSessionFileIfNeeded(params: {
    sessionFile: string;
    warn?: (message: string) => void;
}): Promise<RepairReport>;
export {};
