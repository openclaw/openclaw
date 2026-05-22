//#region src/media/inbound-path-policy.d.ts
declare function isValidInboundPathRootPattern(value: string): boolean;
declare function normalizeInboundPathRoots(roots?: readonly string[]): string[];
declare function mergeInboundPathRoots(...rootsLists: Array<readonly string[] | undefined>): string[];
declare function isInboundPathAllowed(params: {
  filePath: string;
  roots: readonly string[];
  fallbackRoots?: readonly string[];
}): boolean;
//#endregion
export { normalizeInboundPathRoots as i, isValidInboundPathRootPattern as n, mergeInboundPathRoots as r, isInboundPathAllowed as t };