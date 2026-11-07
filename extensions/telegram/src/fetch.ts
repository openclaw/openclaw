import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  captureHttpExchangeAsync,
  resolveEffectiveDebugProxyUrl,
} from "openclaw/plugin-sdk/proxy-capture";
import { createTelegramTransport, type TelegramTransport } from "./fetch-transport.js";

export { resolveTelegramApiBase, shouldRetryTelegramTransportFallback } from "./fetch-transport.js";
export type { TelegramTransport } from "./fetch-transport.js";

// The ingress worker imports ./fetch-transport.js directly, so this capture graph stays out of it.
export function resolveTelegramTransport(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): TelegramTransport {
  return createTelegramTransport(proxyFetch, {
    ...options,
    debugProxyCapture: { captureHttpExchangeAsync, resolveEffectiveDebugProxyUrl },
  });
}

export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): typeof fetch {
  return resolveTelegramTransport(proxyFetch, options).fetch;
}
