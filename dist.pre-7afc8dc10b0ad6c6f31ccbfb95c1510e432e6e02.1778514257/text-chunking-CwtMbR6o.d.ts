//#region src/plugin-sdk/text-chunking.d.ts
/** Chunk outbound text while preferring newline boundaries over spaces. */
declare function chunkTextForOutbound(text: string, limit: number): string[];
//#endregion
export { chunkTextForOutbound as t };