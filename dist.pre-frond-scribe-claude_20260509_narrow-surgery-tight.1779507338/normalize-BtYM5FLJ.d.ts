import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";
//#region extensions/signal/src/install-signal-cli.d.ts
type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};
type NamedAsset = {
  name: string;
  browser_download_url: string;
};
type SignalInstallResult = {
  ok: boolean;
  cliPath?: string;
  version?: string;
  error?: string;
};
/** @internal Exported for testing. */
declare function extractSignalCliArchive(archivePath: string, installRoot: string, timeoutMs: number): Promise<void>;
/** @internal Exported for testing. */
declare function looksLikeArchive(name: string): boolean;
/**
 * Pick a native release asset from the official GitHub releases.
 *
 * The official signal-cli releases only publish native (GraalVM) binaries for
 * x86-64 Linux.  On architectures where no native asset is available this
 * returns `undefined` so the caller can fall back to a different install
 * strategy (e.g. Homebrew).
 */
/** @internal Exported for testing. */
declare function pickAsset(assets: ReleaseAsset[], platform: NodeJS.Platform, arch: string): NamedAsset | undefined;
/** @internal Exported for testing. */
declare function downloadToFile(url: string, dest: string, maxRedirects?: number, maxBytes?: number): Promise<void>;
/** @internal Exported for testing. */
declare function installSignalCliFromRelease(runtime: RuntimeEnv): Promise<SignalInstallResult>;
declare function installSignalCli(runtime: RuntimeEnv): Promise<SignalInstallResult>;
//#endregion
//#region extensions/signal/src/normalize.d.ts
declare function normalizeSignalMessagingTarget(raw: string): string | undefined;
declare function looksLikeSignalTargetId(raw: string, normalized?: string): boolean;
//#endregion
export { SignalInstallResult as a, installSignalCli as c, pickAsset as d, ReleaseAsset as i, installSignalCliFromRelease as l, normalizeSignalMessagingTarget as n, downloadToFile as o, NamedAsset as r, extractSignalCliArchive as s, looksLikeSignalTargetId as t, looksLikeArchive as u };