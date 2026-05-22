//#region src/config/sessions/artifacts.d.ts
declare function isSessionArchiveArtifactName(fileName: string): boolean;
declare function isUsageCountedSessionTranscriptFileName(fileName: string): boolean;
declare function parseUsageCountedSessionIdFromFileName(fileName: string): string | null;
//#endregion
export { isUsageCountedSessionTranscriptFileName as n, parseUsageCountedSessionIdFromFileName as r, isSessionArchiveArtifactName as t };