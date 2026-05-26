//#region src/channels/allow-from.d.ts
declare const ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:";
declare function parseAccessGroupAllowFromEntry(entry: string): string | null;
declare function mergeDmAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: Array<string | number>;
  dmPolicy?: string;
}): string[];
declare function resolveGroupAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  fallbackToAllowFrom?: boolean;
}): string[];
declare function firstDefined<T>(...values: Array<T | undefined>): (T & ({} | null)) | undefined;
declare function isSenderIdAllowed(allow: {
  entries: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
}, senderId: string | undefined, allowWhenEmpty: boolean): boolean;
//#endregion
export { parseAccessGroupAllowFromEntry as a, mergeDmAllowFromSources as i, firstDefined as n, resolveGroupAllowFromSources as o, isSenderIdAllowed as r, ACCESS_GROUP_ALLOW_FROM_PREFIX as t };