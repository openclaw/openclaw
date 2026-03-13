import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import type { PinnedDispatcherPolicy } from "../infra/net/ssrf.js";
export type TelegramTransport = {
    fetch: typeof fetch;
    sourceFetch: typeof fetch;
    pinnedDispatcherPolicy?: PinnedDispatcherPolicy;
};
export declare function resolveTelegramTransport(proxyFetch?: typeof fetch, options?: {
    network?: TelegramNetworkConfig;
}): TelegramTransport;
export declare function resolveTelegramFetch(proxyFetch?: typeof fetch, options?: {
    network?: TelegramNetworkConfig;
}): typeof fetch;
