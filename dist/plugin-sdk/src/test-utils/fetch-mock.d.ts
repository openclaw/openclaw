export type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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
export declare function withFetchPreconnect<T extends typeof fetch>(fn: T): T & FetchWithPreconnect;
export declare function withFetchPreconnect<T extends object>(fn: T): T & FetchWithPreconnect & typeof fetch;
export {};
