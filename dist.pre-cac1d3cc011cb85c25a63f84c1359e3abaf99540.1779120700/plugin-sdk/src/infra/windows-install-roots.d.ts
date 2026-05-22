export declare const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";
type QueryRegistryValue = (key: string, valueName: string) => string | null;
type IsReadableFile = (filePath: string) => boolean;
type WindowsInstallRootsTestOverrides = {
    queryRegistryValue?: QueryRegistryValue;
    isReadableFile?: IsReadableFile;
};
type WindowsInstallRoots = {
    systemRoot: string;
    programFiles: string;
    programFilesX86: string;
    programW6432: string | null;
};
/**
 * Windows install roots should be local absolute directories, not drive-relative
 * paths, UNC shares, or PATH-like lists that could widen trust unexpectedly.
 */
export declare function normalizeWindowsInstallRoot(raw: string | undefined): string | null;
declare function getWindowsRegExeCandidates(): readonly string[];
declare function locateWindowsRegExe(): string | null;
export declare function getWindowsInstallRoots(env?: Record<string, string | undefined>): WindowsInstallRoots;
export declare function getWindowsProgramFilesRoots(env?: Record<string, string | undefined>): readonly string[];
export declare function _resetWindowsInstallRootsForTests(overrides?: WindowsInstallRootsTestOverrides): void;
export declare const _private: {
    getWindowsRegExeCandidates: typeof getWindowsRegExeCandidates;
    locateWindowsRegExe: typeof locateWindowsRegExe;
};
export {};
