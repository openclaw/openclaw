export type ArchiveExtractResult = {
    stdout: string;
    stderr: string;
    code: number | null;
};
export declare function extractArchive(params: {
    archivePath: string;
    archiveType: string;
    targetDir: string;
    stripComponents?: number;
    timeoutMs: number;
}): Promise<ArchiveExtractResult>;
