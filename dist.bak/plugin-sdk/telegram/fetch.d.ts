import type { TelegramNetworkConfig } from "../config/types.telegram.js";
export declare function resolveTelegramFetch(proxyFetch?: typeof fetch, options?: {
    network?: TelegramNetworkConfig;
}): typeof fetch | undefined;
export declare function resetTelegramFetchStateForTests(): void;
