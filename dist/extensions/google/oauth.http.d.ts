//#region extensions/google/oauth.http.d.ts
declare function fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number): Promise<Response>;
//#endregion
export { fetchWithTimeout };