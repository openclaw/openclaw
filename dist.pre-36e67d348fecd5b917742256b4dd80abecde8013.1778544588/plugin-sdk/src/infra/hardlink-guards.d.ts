export declare function assertNoHardlinkedFinalPath(params: {
    filePath: string;
    root: string;
    boundaryLabel: string;
    allowFinalHardlinkForUnlink?: boolean;
}): Promise<void>;
