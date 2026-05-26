import { Dispatcher } from "undici";

//#region src/infra/net/runtime-fetch.d.ts
type DispatcherAwareRequestInit = RequestInit & {
  dispatcher?: Dispatcher;
};
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
declare function isMockedFetch(fetchImpl: FetchLike | undefined): boolean;
declare function fetchWithRuntimeDispatcher(input: RequestInfo | URL, init?: DispatcherAwareRequestInit): Promise<Response>;
declare function fetchWithRuntimeDispatcherOrMockedGlobal(input: RequestInfo | URL, init?: DispatcherAwareRequestInit): Promise<Response>;
//#endregion
export { isMockedFetch as i, fetchWithRuntimeDispatcher as n, fetchWithRuntimeDispatcherOrMockedGlobal as r, DispatcherAwareRequestInit as t };