import { type ExecFn } from "./windows-acl.js";
export type PermissionCheck = {
    ok: boolean;
    isSymlink: boolean;
    isDir: boolean;
    mode: number | null;
    bits: number | null;
    source: "posix" | "windows-acl" | "unknown";
    worldWritable: boolean;
    groupWritable: boolean;
    worldReadable: boolean;
    groupReadable: boolean;
    aclSummary?: string;
    error?: string;
};
export type PermissionCheckOptions = {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    exec?: ExecFn;
};
export declare function safeStat(targetPath: string): Promise<{
    ok: boolean;
    isSymlink: boolean;
    isDir: boolean;
    mode: number | null;
    uid: number | null;
    gid: number | null;
    error?: string;
}>;
export declare function inspectPathPermissions(targetPath: string, opts?: PermissionCheckOptions): Promise<PermissionCheck>;
export declare function formatPermissionDetail(targetPath: string, perms: PermissionCheck): string;
export declare function formatPermissionRemediation(params: {
    targetPath: string;
    perms: PermissionCheck;
    isDir: boolean;
    posixMode: number;
    env?: NodeJS.ProcessEnv;
}): string;
export declare function modeBits(mode: number | null): number | null;
export declare function formatOctal(bits: number | null): string;
export declare function isWorldWritable(bits: number | null): boolean;
export declare function isGroupWritable(bits: number | null): boolean;
export declare function isWorldReadable(bits: number | null): boolean;
export declare function isGroupReadable(bits: number | null): boolean;
