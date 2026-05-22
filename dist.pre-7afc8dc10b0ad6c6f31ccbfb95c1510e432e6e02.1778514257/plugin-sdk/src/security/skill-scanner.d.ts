export type SkillScanSeverity = "info" | "warn" | "critical";
export type SkillScanFinding = {
    ruleId: string;
    severity: SkillScanSeverity;
    file: string;
    line: number;
    message: string;
    evidence: string;
};
export type SkillScanSummary = {
    scannedFiles: number;
    critical: number;
    warn: number;
    info: number;
    findings: SkillScanFinding[];
};
export type SkillScanOptions = {
    excludeTestFiles?: boolean;
    includeFiles?: string[];
    maxFiles?: number;
    maxFileBytes?: number;
};
export declare function isScannable(filePath: string): boolean;
export declare function clearSkillScanCacheForTest(): void;
export declare function scanSource(source: string, filePath: string): SkillScanFinding[];
export declare function scanDirectory(dirPath: string, opts?: SkillScanOptions): Promise<SkillScanFinding[]>;
export declare function scanDirectoryWithSummary(dirPath: string, opts?: SkillScanOptions): Promise<SkillScanSummary>;
