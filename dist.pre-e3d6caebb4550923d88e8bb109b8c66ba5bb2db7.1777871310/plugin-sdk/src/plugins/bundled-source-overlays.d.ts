export declare function parseLinuxMountInfoMountPoints(mountInfo: string): Set<string>;
export declare function isBundledSourceOverlayPath(params: {
    sourcePath: string;
    mountPoints?: ReadonlySet<string>;
}): boolean;
export declare function listBundledSourceOverlayDirs(params: {
    bundledRoot?: string;
    env?: NodeJS.ProcessEnv;
    mountPoints?: ReadonlySet<string>;
}): string[];
