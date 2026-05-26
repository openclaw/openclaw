//#region src/plugin-sdk/resolution-notes.d.ts
/** Format a short note that separates successfully resolved targets from unresolved passthrough values. */
declare function formatResolvedUnresolvedNote(params: {
  resolved: string[];
  unresolved: string[];
}): string | undefined;
//#endregion
export { formatResolvedUnresolvedNote as t };