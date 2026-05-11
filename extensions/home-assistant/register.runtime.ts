/**
 * Production plugin wiring.
 *
 * What this does on plugin register:
 *   1. Parses `api.pluginConfig` through the shared schema. On failure,
 *      registers a no-op service that logs "disabled until configured"
 *      and returns -- matching the memory-lancedb pattern.
 *   2. Builds a `HomeAssistantStateStore` keyed off the operator's
 *      allow-list.
 *   3. Attaches the gateway bridge eagerly so `home-assistant.subscribe`
 *      and `home-assistant.serviceCall` are reachable as soon as the
 *      kiosk client connects. The bridge consumes a late-bound service-
 *      call adapter; the actual WS client is created when the service
 *      starts (which is when credentials get resolved).
 *   4. Registers a service whose `start` resolves the long-lived token
 *      via the SDK secret-ref helper, instantiates the WS client, and
 *      calls `client.start()`. `stop` tears the client down.
 *
 * Boundary: imports only `openclaw/plugin-sdk/*` and this package's own
 * barrels. No deep imports into `src/**` per `extensions/CLAUDE.md`.
 */

import { resolveRequiredConfiguredSecretRefInputString } from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseHomeAssistantConfig, type HomeAssistantConfig } from "./config-schema.js";
import {
  attachHomeAssistantBridge,
  type BridgeLogger,
  type ServiceCallClient,
} from "./gateway-bridge.js";
import { HomeAssistantStateStore } from "./state-store.js";
import {
  HomeAssistantClient,
  type Logger,
  type WebSocketLike,
  type WebSocketLikeFactory,
} from "./ws-client.js";

const PLUGIN_ID = "home-assistant";

export function registerHomeAssistantPlugin(api: OpenClawPluginApi): void {
  const parseResult = parseHomeAssistantConfig(api.pluginConfig);
  if (!parseResult.success) {
    const detail = parseResult.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    api.registerService({
      id: PLUGIN_ID,
      start: () => {
        api.logger.warn(`home-assistant: disabled until configured (${detail})`);
      },
    });
    return;
  }

  const config = parseResult.data;
  const store = new HomeAssistantStateStore({ allowList: config.allowList });

  let client: HomeAssistantClient | null = null;

  // Late-bound adapter so the bridge can be attached during register()
  // (so gateway methods exist as soon as the gateway is up) while the
  // actual WS client is only instantiated when the service starts and
  // the token resolves.
  const serviceCallAdapter: ServiceCallClient = {
    callService(args) {
      if (!client) {
        throw new Error("home-assistant: WebSocket client not yet started");
      }
      client.callService(args);
    },
  };

  attachHomeAssistantBridge({
    api: api as Parameters<typeof attachHomeAssistantBridge>[0]["api"],
    store,
    client: serviceCallAdapter,
    config,
    logger: bridgeLoggerFor(api),
  });

  api.registerService({
    id: PLUGIN_ID,
    start: async (ctx) => {
      const token = await resolveRequiredConfiguredSecretRefInputString({
        config: ctx.config,
        env: process.env,
        value: config.tokenRef,
        path: `plugins.entries.${PLUGIN_ID}.config.tokenRef`,
      });
      if (!token) {
        ctx.logger.warn(
          `home-assistant: token reference "${config.tokenRef}" did not resolve to a value`,
        );
        return;
      }

      client = new HomeAssistantClient({
        url: config.homeAssistantUrl,
        token,
        store,
        webSocketFactory: defaultWebSocketFactory(),
        logger: wsClientLoggerFor(ctx.logger),
      });
      client.start();
    },
    stop: async () => {
      client?.stop();
      client = null;
    },
  });
}

function defaultWebSocketFactory(): WebSocketLikeFactory {
  // Node 22+ ships globalThis.WebSocket. The WHATWG interface matches
  // our WebSocketLike contract structurally.
  return (url: string): WebSocketLike => {
    const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike })
      .WebSocket;
    if (!WebSocketCtor) {
      throw new Error(
        "home-assistant: globalThis.WebSocket is unavailable; need Node 22+ or a polyfill",
      );
    }
    return new WebSocketCtor(url);
  };
}

function wsClientLoggerFor(logger: {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
}): Logger {
  return (entry) => {
    const formatted = entry.data ? `${entry.message} ${safeStringify(entry.data)}` : entry.message;
    if (entry.level === "info") logger.info(formatted);
    else if (entry.level === "warn") logger.warn(formatted);
    else logger.error(formatted);
  };
}

function bridgeLoggerFor(api: OpenClawPluginApi): BridgeLogger {
  return (entry) => {
    const formatted = entry.data ? `${entry.message} ${safeStringify(entry.data)}` : entry.message;
    if (entry.level === "info") api.logger.info(formatted);
    else if (entry.level === "warn") api.logger.warn(formatted);
    else api.logger.error(formatted);
  };
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Exposed for tests so the registration can be replayed without
 * standing up a real plugin host.
 */
export type RegisterHomeAssistantPluginContext = {
  config: HomeAssistantConfig;
};
