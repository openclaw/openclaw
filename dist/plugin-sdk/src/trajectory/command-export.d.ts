export type TrajectoryCommandExportSummary = {
    outputDir: string;
    displayPath: string;
    sessionId: string;
    eventCount: number;
    runtimeEventCount: number;
    transcriptEventCount: number;
    files: string[];
};
export declare function resolveTrajectoryCommandOutputDir(params: {
    outputPath?: string;
    workspaceDir: string;
    sessionId: string;
}): Promise<string>;
export declare function exportTrajectoryForCommand(params: {
    outputDir?: string;
    outputPath?: string;
    sessionFile: string;
    sessionId: string;
    sessionKey: string;
    workspaceDir: string;
}): Promise<TrajectoryCommandExportSummary>;
export declare function formatTrajectoryCommandExportSummary(summary: TrajectoryCommandExportSummary): string;
