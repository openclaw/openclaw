//#region node_modules/@openclaw/fs-safe/dist/local-file-access.d.ts
declare function hasEncodedFileUrlSeparator(pathname: string): boolean;
declare function isWindowsNetworkPath(filePath: string, platform?: NodeJS.Platform): boolean;
declare function assertNoWindowsNetworkPath(filePath: string, label?: string): void;
declare function safeFileURLToPath(fileUrl: string): string;
declare function trySafeFileURLToPath(fileUrl: string): string | undefined;
declare function basenameFromMediaSource(source?: string): string | undefined;
//#endregion
export { safeFileURLToPath as a, isWindowsNetworkPath as i, basenameFromMediaSource as n, trySafeFileURLToPath as o, hasEncodedFileUrlSeparator as r, assertNoWindowsNetworkPath as t };