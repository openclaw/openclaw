//#region extensions/browser/test-fetch.d.ts
type FetchPreconnectOptions = {
  dns?: boolean;
  tcp?: boolean;
  http?: boolean;
  https?: boolean;
};
type FetchWithPreconnect = {
  preconnect: (url: string | URL, options?: FetchPreconnectOptions) => void;
  __openclawAcceptsDispatcher: true;
};
declare function withBrowserFetchPreconnect<T extends typeof fetch>(fn: T): T & FetchWithPreconnect;
declare function withBrowserFetchPreconnect<T extends object>(fn: T): T & FetchWithPreconnect & typeof fetch;
//#endregion
export { withBrowserFetchPreconnect };