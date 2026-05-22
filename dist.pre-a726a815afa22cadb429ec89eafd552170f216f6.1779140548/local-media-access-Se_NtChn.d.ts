//#region src/media/local-media-access.d.ts
type LocalMediaAccessErrorCode = "path-not-allowed" | "invalid-root" | "invalid-file-url" | "network-path-not-allowed" | "unsafe-bypass" | "not-found" | "invalid-path" | "not-file";
declare class LocalMediaAccessError extends Error {
  code: LocalMediaAccessErrorCode;
  constructor(code: LocalMediaAccessErrorCode, message: string, options?: ErrorOptions);
}
declare function getDefaultLocalRoots(): readonly string[];
declare function assertLocalMediaAllowed(mediaPath: string, localRoots: readonly string[] | "any" | undefined): Promise<void>;
//#endregion
export { getDefaultLocalRoots as i, LocalMediaAccessErrorCode as n, assertLocalMediaAllowed as r, LocalMediaAccessError as t };