import { c as fetchWithTimeoutGuarded } from "../../provider-http-ByynA2MJ.js";

//#region extensions/openrouter/video-http.d.ts
type GuardedFetchResult = Awaited<ReturnType<typeof fetchWithTimeoutGuarded>>;
type FetchGuardOptions = NonNullable<Parameters<typeof fetchWithTimeoutGuarded>[4]>;
type OpenRouterVideoDispatcherPolicy = FetchGuardOptions["dispatcherPolicy"];
declare function resolveOpenRouterVideoUrl(url: string, baseUrl: string): string;
declare function fetchOpenRouterVideoGet(params: {
  url: string;
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: OpenRouterVideoDispatcherPolicy;
  auditContext: string;
}): Promise<GuardedFetchResult>;
//#endregion
export { OpenRouterVideoDispatcherPolicy, fetchOpenRouterVideoGet, resolveOpenRouterVideoUrl };