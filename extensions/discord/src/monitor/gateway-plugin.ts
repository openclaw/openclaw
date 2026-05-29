import { randomUUID } from "node:crypto";
import type { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createNodeProxyAgent } from "openclaw/plugin-sdk/fetch-runtime";
import {
  captureWsEvent,
  resolveEffectiveDebugProxyUrl,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import * as ws from "ws";
import * as discordGateway from "../internal/gateway.js";
import { createDiscordDnsLookup } from "../network-config.js";
import { validateDiscordProxyUrl } from "../proxy-fetch.js";
import { resolveDiscordVoiceEnabled } from "../voice/config.js";
import { DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT } from "./gateway-handle.js";
import {
  fetchDiscordGatewayInfoWithTimeout,
  fetchDiscordGatewayMetadataGuarded,
  resolveDiscordGatewayInfoTimeoutMs,
  resolveGatewayInfoWithFallback,
  type DiscordGatewayFetch,
  type DiscordGatewayFetchInit,
} from "./gateway-metadata.js";

export {
  parseDiscordGatewayInfoBody,
  resolveDiscordGatewayInfoTimeoutMs,
} from "./gateway-metadata.js";

const DISCORD_GATEWAY_HANDSHAKE_TIMEOUT_MS = 30_000;
const discordDnsLookup = createDiscordDnsLookup();

type DiscordGatewayWebSocketCtor = new (
  url: string,
  options?: { agent?: unknown; handshakeTimeout?: number },
) => ws.WebSocket;
type DiscordGatewayWebSocketAgent = InstanceType<typeof HttpsAgent> | HttpAgent;
const registrationPromises = new WeakMap<discordGateway.GatewayPlugin, Promise<void>>();
type DiscordGatewayClient = Parameters<discordGateway.GatewayPlugin["registerClient"]>[0];
type GatewayPluginTestingOptions = {
  registerClient?: (
    plugin: discordGateway.GatewayPlugin,
    client: DiscordGatewayClient,
  ) => Promise<void>;
  webSocketCtor?: DiscordGatewayWebSocketCtor;
};
type CreateDiscordGatewayPluginTestingOptions = GatewayPluginTestingOptions & {
  createProxyAgent?: (proxyUrl: string) => HttpAgent;
};
type DiscordGatewayRegistrationState = {
  client?: DiscordGatewayClient;
  ws?: unknown;
  isConnecting?: boolean;
};

function assignGatewayClient(
  plugin: discordGateway.GatewayPlugin,
  client: DiscordGatewayClient,
): void {
  (plugin as unknown as DiscordGatewayRegistrationState).client = client;
}

function hasGatewaySocketStarted(plugin: discordGateway.GatewayPlugin): boolean {
  const state = plugin as unknown as DiscordGatewayRegistrationState;
  return state.ws != null || state.isConnecting === true;
}

type ResolveDiscordGatewayIntentsParams = {
  intentsConfig?: import("openclaw/plugin-sdk/config-contracts").DiscordIntentsConfig;
  voiceEnabled?: boolean;
};

export function resolveDiscordGatewayIntents(params?: ResolveDiscordGatewayIntentsParams): number {
  const intentsConfig = params?.intentsConfig;
  const voiceEnabled = params?.voiceEnabled;
  const voiceStatesEnabled = intentsConfig?.voiceStates ?? voiceEnabled ?? false;
  let intents =
    discordGateway.GatewayIntents.Guilds |
    discordGateway.GatewayIntents.GuildMessages |
    discordGateway.GatewayIntents.MessageContent |
    discordGateway.GatewayIntents.DirectMessages |
    discordGateway.GatewayIntents.GuildMessageReactions |
    discordGateway.GatewayIntents.DirectMessageReactions;
  if (voiceStatesEnabled) {
    intents |= discordGateway.GatewayIntents.GuildVoiceStates;
  }
  if (intentsConfig?.presence) {
    intents |= discordGateway.GatewayIntents.GuildPresences;
  }
  if (intentsConfig?.guildMembers) {
    intents |= discordGateway.GatewayIntents.GuildMembers;
  }
  return intents;
}

function createGatewayPlugin(params: {
  options: {
    reconnect: { maxAttempts: number };
    intents: number;
    autoInteractions: boolean;
  };
  /** Per-account startup jitter in ms (0 = no delay). Applied only on the
   *  first connect() call to spread simultaneous gateway connections across
   *  accounts without affecting exponential-backoff reconnect scheduling. */
  startupJitterMs?: number;
  gatewayInfoTimeoutMs: number;
  fetchImpl: DiscordGatewayFetch;
  fetchInit?: DiscordGatewayFetchInit;
  wsAgent?: DiscordGatewayWebSocketAgent;
  runtime?: RuntimeEnv;
  testing?: GatewayPluginTestingOptions;
}): discordGateway.GatewayPlugin {
  class OpenClawGatewayPlugin extends discordGateway.GatewayPlugin {
    private gatewayInfoUsedFallback = false;
    private remainingStartupJitterMs = params.startupJitterMs ?? 0;

    constructor() {
      super(params.options);
    }

    override connect(resume = false): void {
      // Apply per-account startup jitter on the first non-resume connect only.
      // Subsequent reconnects skip the delay so exponential backoff is unaffected.
      const jitter = this.remainingStartupJitterMs;
      if (!resume && jitter > 0) {
        this.remainingStartupJitterMs = 0;
        setTimeout(() => {
          super.connect(resume);
        }, jitter).unref();
        return;
      }
      super.connect(resume);
    }

    override registerClient(client: DiscordGatewayClient) {
      const registration = this.registerClientInternal(client);
      // Client construction starts plugin hooks without awaiting them. Mark the
      // promise handled immediately, then let startup await the original promise.
      registration.catch(() => {});
      registrationPromises.set(this, registration);
      return registration;
    }

    private async registerClientInternal(client: DiscordGatewayClient) {
      // Publish the client reference before the metadata fetch can yield, so an external
      // connect()->identify() cannot silently drop IDENTIFY (#52372).
      assignGatewayClient(this, client);

      if (!this.gatewayInfo || this.gatewayInfoUsedFallback) {
        const resolved = await fetchDiscordGatewayInfoWithTimeout({
          token: client.options.token,
          fetchImpl: params.fetchImpl,
          fetchInit: params.fetchInit,
          timeoutMs: params.gatewayInfoTimeoutMs,
        })
          .then((info) => ({
            info,
            usedFallback: false,
          }))
          .catch((error) => resolveGatewayInfoWithFallback({ runtime: params.runtime, error }));
        this.gatewayInfo = resolved.info;
        this.gatewayInfoUsedFallback = resolved.usedFallback;
      }
      if (params.testing?.registerClient) {
        await params.testing.registerClient(this, client);
        return;
      }
      // If the lifecycle timeout already started a socket while metadata was
      // loading, do not register again; it would close that socket and open another one.
      if (hasGatewaySocketStarted(this)) {
        return;
      }
      return super.registerClient(client);
    }

    override createWebSocket(url: string) {
      if (!url) {
        throw new Error("Gateway URL is required");
      }
      const wsFlowId = randomUUID();
      // Avoid Node's undici-backed global WebSocket here. We have seen late
      // close-path crashes during Discord gateway teardown; the ws transport is
      // already our proxy path and behaves predictably for lifecycle cleanup.
      const WebSocketCtor = params.testing?.webSocketCtor ?? ws.default;
      const socket = new WebSocketCtor(url, {
        handshakeTimeout: DISCORD_GATEWAY_HANDSHAKE_TIMEOUT_MS,
        ...(params.wsAgent ? { agent: params.wsAgent } : {}),
      });
      const emitTransportActivity = () => {
        if ((this as unknown as { ws?: unknown }).ws !== socket) {
          return;
        }
        this.emitter.emit(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, { at: Date.now() });
      };
      captureWsEvent({
        url,
        direction: "local",
        kind: "ws-open",
        flowId: wsFlowId,
        meta: { subsystem: "discord-gateway" },
      });
      socket.on?.("message", (data: unknown) => {
        emitTransportActivity();
        captureWsEvent({
          url,
          direction: "inbound",
          kind: "ws-frame",
          flowId: wsFlowId,
          payload: Buffer.isBuffer(data) ? data : Buffer.from(String(data)),
          meta: { subsystem: "discord-gateway" },
        });
      });
      socket.on?.("close", (code: number, reason: Buffer) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-close",
          flowId: wsFlowId,
          closeCode: code,
          payload: reason,
          meta: { subsystem: "discord-gateway" },
        });
      });
      socket.on?.("error", (error: Error) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "error",
          flowId: wsFlowId,
          errorText: error.message,
          meta: { subsystem: "discord-gateway" },
        });
      });
      if ("binaryType" in socket) {
        try {
          socket.binaryType = "arraybuffer";
        } catch {
          // Ignore runtimes that expose a readonly binaryType.
        }
      }
      return socket;
    }
  }

  return new OpenClawGatewayPlugin();
}

function createDiscordGatewayMetadataFetch(
  debugCaptureEnabled: boolean,
  proxyUrl?: string,
): DiscordGatewayFetch {
  return (input, init) =>
    fetchDiscordGatewayMetadataGuarded(input, init, {
      ...(debugCaptureEnabled
        ? {}
        : {
            capture: {
              flowId: randomUUID(),
              meta: { subsystem: "discord-gateway-metadata" },
            },
          }),
      ...(proxyUrl ? { proxyUrl } : {}),
    });
}

export function waitForDiscordGatewayPluginRegistration(
  plugin: unknown,
): Promise<void> | undefined {
  if (typeof plugin !== "object" || plugin === null) {
    return undefined;
  }
  return registrationPromises.get(plugin as discordGateway.GatewayPlugin);
}

// Compute a deterministic per-account startup jitter (0–249 ms) to spread
// simultaneous gateway connect() calls and avoid a thundering-herd burst on
// multi-account gateway restarts. The range is intentionally small so that
// startup is barely perceptible, and is additive — not a replacement of
// Carbon's own exponential-backoff base, which is hardcoded at 1 s × 2^n.
export function computeAccountStartupJitterMs(accountId: string): number {
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) {
    hash = (hash * 31 + accountId.charCodeAt(i)) >>> 0;
  }
  return hash % 250;
}

export function createDiscordGatewayPlugin(params: {
  accountId?: string;
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv;
  testing?: CreateDiscordGatewayPluginTestingOptions;
}): discordGateway.GatewayPlugin {
  const intents = resolveDiscordGatewayIntents({
    intentsConfig: params.discordConfig?.intents,
    voiceEnabled: resolveDiscordVoiceEnabled(params.discordConfig?.voice),
  });
  const proxy = resolveEffectiveDebugProxyUrl(params.discordConfig?.proxy);
  const debugProxySettings = resolveDebugProxySettings();
  const gatewayInfoTimeoutMs = resolveDiscordGatewayInfoTimeoutMs({
    configuredTimeoutMs: params.discordConfig?.gatewayInfoTimeoutMs,
    env: process.env,
  });
  const startupJitterMs = params.accountId ? computeAccountStartupJitterMs(params.accountId) : 0;
  let fetchImpl = createDiscordGatewayMetadataFetch(debugProxySettings.enabled);
  let wsAgent: DiscordGatewayWebSocketAgent = new HttpsAgent({
    lookup: discordDnsLookup,
  });

  if (proxy) {
    try {
      validateDiscordProxyUrl(proxy);
      wsAgent =
        params.testing?.createProxyAgent?.(proxy) ??
        createNodeProxyAgent({ mode: "explicit", proxyUrl: proxy, protocol: "https" });
      fetchImpl = createDiscordGatewayMetadataFetch(debugProxySettings.enabled, proxy);
      params.runtime.log?.("discord: gateway proxy enabled");
    } catch (err) {
      params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
      fetchImpl = (input, init) =>
        fetchDiscordGatewayMetadataGuarded(input, init, { capture: false });
    }
  }

  return createGatewayPlugin({
    options: {
      reconnect: { maxAttempts: 50 },
      intents,
      // OpenClaw registers its own async interaction listener.
      autoInteractions: false,
    },
    startupJitterMs,
    gatewayInfoTimeoutMs,
    fetchImpl,
    runtime: params.runtime,
    testing: params.testing,
    ...(wsAgent ? { wsAgent } : {}),
  });
}
