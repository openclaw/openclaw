import type { RuntimeEnv } from "../runtime.js";
export type ReleaseAsset = {
    name?: string;
    browser_download_url?: string;
};
export type NamedAsset = {
    name: string;
    browser_download_url: string;
};
export type SignalInstallResult = {
    ok: boolean;
    cliPath?: string;
    version?: string;
    error?: string;
};
/** @internal Exported for testing. */
export declare function extractSignalCliArchive(archivePath: string, installRoot: string, timeoutMs: number): Promise<void>;
/** @internal Exported for testing. */
export declare function looksLikeArchive(name: string): boolean;
/**
 * Pick a native release asset from the official GitHub releases.
 *
 * The official signal-cli releases only publish native (GraalVM) binaries for
 * x86-64 Linux.  On architectures where no native asset is available this
 * returns `undefined` so the caller can fall back to a different install
 * strategy (e.g. Homebrew).
 */
/** @internal Exported for testing. */
export declare function pickAsset(assets: ReleaseAsset[], platform: NodeJS.Platform, arch: string): NamedAsset | undefined;
export declare function installSignalCli(runtime: RuntimeEnv): Promise<SignalInstallResult>;
