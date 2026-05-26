//#region extensions/google/gemini-auth.d.ts
declare function parseGeminiAuth(apiKey: string): {
  headers: Record<string, string>;
};
//#endregion
export { parseGeminiAuth as t };