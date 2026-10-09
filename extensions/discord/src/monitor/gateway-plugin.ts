import { randomUUID } from "node:crypto";
import type { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createNodeProxyAgent } from "openclaw/plugin-sdk/fetch-runtime";
import * as proxyCaptureSdk from "openclaw/plugin-sdk/proxy-capture";
import {
  resolveEffectiveDebugProxyUrl,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import { danger, warn } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { asFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type * as ws from "ws";
import { assertDiscordEndpointGatewayUrl, getDiscordEndpointRuntime } from "../endpoint-runtime.js";
import * as discordGateway from "../internal/gateway.js";
import { WebSocket } from "../internal/ws-runtime.js";
import { createDiscordDnsLookup, createDiscordEndpointDnsLookup } from "../network-config.js";
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

// The shipped 2026.9.6 host omits async capture; retire this check when the minimum advances.
const captureSdk: Partial<Pick<typeof proxyCaptureSdk, "captureWsEventAsync">> = proxyCaptureSdk;

const DISCORD_GATEWAY_POLICY_VIOLATION_CLOSE_CODE = 1008;
const DISCORD_GATEWAY_WS_RECEIVER_LIMIT_CODE = "WS_ERR_TOO_MANY_BUFFERED_PARTS";
const DISCORD_GATEWAY_CLOSE_REASON_LOG_MAX_CHARS = 240;
const discordDnsLookup = createDiscordDnsLookup();

type DiscordGatewayWebSocketCtor = typeof ws.WebSocket;
type DiscordGatewayWebSocketAgent = InstanceType<typeof HttpsAgent> | HttpAgent;
type DiscordGatewayEndpoint = Readonly<{
  gatewayBotUrl: string;
  gatewayOrigin: string;
  fetch: typeof fetch;
}>;
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
type DiscordGatewayTransportErrorDetails = {
  name?: string;
  message: string;
  code?: string;
  closeCode?: number;
  statusCode?: number;
};

function describeDiscordGatewayTransportError(error: Error): DiscordGatewayTransportErrorDetails {
  const fields = error as Error & Record<string, unknown>;
  const rawCode = fields.code;
  const code = typeof rawCode === "string" && rawCode ? rawCode : undefined;
  const closeCode = asFiniteNumber(fields.closeCode);
  const statusCode = asFiniteNumber(fields.statusCode);
  return {
    ...(error.name ? { name: error.name } : {}),
    message: error.message,
    ...(code ? { code } : {}),
    ...(closeCode !== undefined ? { closeCode } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  };
}

function formatDiscordGatewayCloseReason(reason: Buffer): string {
  if (!reason.length) {
    return "<empty>";
  }
  const text = reason.toString("utf8").replaceAll(/\s+/g, " ").trim();
  if (!text) {
    return `<${reason.length} bytes>`;
  }
  if (text.length <= DISCORD_GATEWAY_CLOSE_REASON_LOG_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, DISCORD_GATEWAY_CLOSE_REASON_LOG_MAX_CHARS)}...`;
}

function formatDiscordGatewayTransportErrorLog(params: {
  flowId: string;
  error: DiscordGatewayTransportErrorDetails;
}): string {
  const details = [
    `flow=${params.flowId}`,
    params.error.name ? `name=${params.error.name}` : undefined,
    params.error.code ? `code=${params.error.code}` : undefined,
    typeof params.error.closeCode === "number" ? `closeCode=${params.error.closeCode}` : undefined,
    typeof params.error.statusCode === "number"
      ? `statusCode=${params.error.statusCode}`
      : undefined,
    `message=${params.error.message}`,
  ].filter(Boolean);
  return `discord: gateway websocket error ${details.join(" ")}`;
}

function formatDiscordGatewayTransportCloseLog(params: {
  flowId: string;
  code: number;
  reason: Buffer;
  lastError?: DiscordGatewayTransportErrorDetails;
}): string {
  const receiverLimit =
    params.code === DISCORD_GATEWAY_POLICY_VIOLATION_CLOSE_CODE ||
    params.lastError?.code === DISCORD_GATEWAY_WS_RECEIVER_LIMIT_CODE;
  const details = [
    `flow=${params.flowId}`,
    `code=${params.code}`,
    `reasonBytes=${params.reason.length}`,
    `reason=${formatDiscordGatewayCloseReason(params.reason)}`,
    params.lastError?.code ? `lastErrorCode=${params.lastError.code}` : undefined,
    params.lastError?.message ? `lastError=${params.lastError.message}` : undefined,
    receiverLimit ? "hint=possible ws receiver buffered-parts limit" : undefined,
  ].filter(Boolean);
  return `discord: gateway websocket closed ${details.join(" ")}`;
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
    discordGateway.GatewayIntents.GuildExpressions |
    discordGateway.GatewayIntents.GuildMessages |
    discordGateway.GatewayIntents.DirectMessages |
    discordGateway.GatewayIntents.GuildMessageReactions |
    discordGateway.GatewayIntents.DirectMessageReactions;
  if (intentsConfig?.messageContent !== false) {
    intents |= discordGateway.GatewayIntents.MessageContent;
  }
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
  intents: number;
  gatewayInfoTimeoutMs: number;
  endpoint?: DiscordGatewayEndpoint;
  fetchImpl: DiscordGatewayFetch;
  fetchInit?: DiscordGatewayFetchInit;
  wsAgent?: DiscordGatewayWebSocketAgent;
  runtime?: RuntimeEnv;
  testing?: GatewayPluginTestingOptions;
}): discordGateway.GatewayPlugin {
  class OpenClawGatewayPlugin extends discordGateway.GatewayPlugin {
    private gatewayInfoUsedFallback = false;

    constructor() {
      super({ intents: params.intents });
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
      this.client = client;

      if (!this.gatewayInfo || this.gatewayInfoUsedFallback) {
        const resolved = await fetchDiscordGatewayInfoWithTimeout({
          token: client.options.token,
          ...(params.endpoint ? { gatewayBotUrl: params.endpoint.gatewayBotUrl } : {}),
          fetchImpl: params.fetchImpl,
          fetchInit: params.fetchInit,
          timeoutMs: params.gatewayInfoTimeoutMs,
        })
          .then((info) => ({
            info,
            usedFallback: false,
          }))
          .catch((error: unknown) => {
            if (params.endpoint) {
              throw error;
            }
            return resolveGatewayInfoWithFallback({ runtime: params.runtime, error });
          });
        this.gatewayInfo = resolved.info;
        this.gatewayInfoUsedFallback = resolved.usedFallback;
      }
      if (params.testing?.registerClient) {
        await params.testing.registerClient(this, client);
        return;
      }
      // If the lifecycle timeout already started a socket while metadata was
      // loading, do not register again; it would close that socket and open another one.
      if (this.ws != null || this.isConnecting) {
        return;
      }
      return super.registerClient(client);
    }

    override createWebSocket(url: string) {
      if (!url) {
        throw new Error("Gateway URL is required");
      }
      assertDiscordEndpointGatewayUrl(url, params.endpoint?.gatewayOrigin);
      const wsFlowId = randomUUID();
      // Avoid Node's undici-backed global WebSocket here. We have seen late
      // close-path crashes during Discord gateway teardown; the ws transport is
      // already our proxy path and behaves predictably for lifecycle cleanup.
      const WebSocketCtor = params.testing?.webSocketCtor ?? WebSocket;
      const socket = new WebSocketCtor(url, {
        ...discordGateway.DISCORD_GATEWAY_WS_CLIENT_OPTIONS,
        ...(params.wsAgent ? { agent: params.wsAgent } : {}),
      });
      let lastTransportError: DiscordGatewayTransportErrorDetails | undefined;
      const emitTransportActivity = () => {
        if (this.ws !== socket) {
          return;
        }
        this.emitter.emit(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, { at: Date.now() });
      };
      // Finalization retains capture failures; observe Promises returned by the SDK view.
      const captureEvent = (
        event: () => Omit<
          Parameters<typeof proxyCaptureSdk.captureWsEventAsync>[0],
          "url" | "flowId" | "meta"
        >,
      ) => {
        void captureSdk
          .captureWsEventAsync?.({
            url,
            ...event(),
            flowId: wsFlowId,
            meta: { subsystem: "discord-gateway" },
          })
          .catch(() => {});
      };
      captureEvent(() => ({ direction: "local", kind: "ws-open" }));
      socket.on?.("message", (data: unknown) => {
        emitTransportActivity();
        captureEvent(() => ({
          direction: "inbound",
          kind: "ws-frame",
          payload: Buffer.isBuffer(data) ? data : Buffer.from(String(data)),
        }));
      });
      socket.on?.("close", (code: number, reason: Buffer) => {
        const closeReason = Buffer.isBuffer(reason) ? reason : Buffer.from(String(reason ?? ""));
        captureEvent(() => ({
          direction: "local",
          kind: "ws-close",
          closeCode: code,
          payload: closeReason,
        }));
        if (
          (code !== 1000 && code !== 1001) ||
          closeReason.length > 0 ||
          lastTransportError !== undefined
        ) {
          params.runtime?.log?.(
            warn(
              formatDiscordGatewayTransportCloseLog({
                flowId: wsFlowId,
                code,
                reason: closeReason,
                lastError: lastTransportError,
              }),
            ),
          );
        }
      });
      socket.on?.("error", (error: Error) => {
        lastTransportError = describeDiscordGatewayTransportError(error);
        captureEvent(() => ({
          direction: "local",
          kind: "error",
          errorText: error.message,
        }));
        params.runtime?.log?.(
          warn(
            formatDiscordGatewayTransportErrorLog({ flowId: wsFlowId, error: lastTransportError }),
          ),
        );
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
  transport?: { endpoint?: DiscordGatewayEndpoint; proxyUrl?: string },
): DiscordGatewayFetch {
  const endpoint = transport?.endpoint;
  if (endpoint) {
    return (input, init) => {
      const signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      return endpoint.fetch(input, {
        ...(init?.headers ? { headers: init.headers } : {}),
        ...(signal ? { signal } : {}),
      });
    };
  }
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
      ...(transport?.proxyUrl ? { proxyUrl: transport.proxyUrl } : {}),
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

export function createDiscordGatewayPlugin(params: {
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
    env: process.env,
  });
  const endpointRuntime = getDiscordEndpointRuntime();
  const endpoint = endpointRuntime
    ? {
        gatewayBotUrl: endpointRuntime.descriptor.gatewayBotUrl,
        gatewayOrigin: endpointRuntime.descriptor.gatewayOrigin,
        fetch: endpointRuntime.fetch,
      }
    : undefined;
  const endpointGatewayUrl = endpoint ? new URL(endpoint.gatewayOrigin) : undefined;
  let fetchImpl = createDiscordGatewayMetadataFetch(
    debugProxySettings.enabled,
    endpoint ? { endpoint } : undefined,
  );
  let wsAgent: DiscordGatewayWebSocketAgent | undefined =
    endpointGatewayUrl?.protocol === "ws:"
      ? undefined
      : new HttpsAgent({
          lookup: endpointGatewayUrl
            ? createDiscordEndpointDnsLookup(endpointGatewayUrl.hostname)
            : discordDnsLookup,
        });

  if (proxy && !endpoint) {
    try {
      validateDiscordProxyUrl(proxy);
      wsAgent =
        params.testing?.createProxyAgent?.(proxy) ??
        createNodeProxyAgent({ mode: "explicit", proxyUrl: proxy, protocol: "https" });
      fetchImpl = createDiscordGatewayMetadataFetch(debugProxySettings.enabled, {
        proxyUrl: proxy,
      });
      params.runtime.log?.("discord: gateway proxy enabled");
    } catch (err) {
      params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
      fetchImpl = (input, init) =>
        fetchDiscordGatewayMetadataGuarded(input, init, { capture: false });
    }
  }

  return createGatewayPlugin({
    intents,
    gatewayInfoTimeoutMs,
    ...(endpoint ? { endpoint } : {}),
    fetchImpl,
    runtime: params.runtime,
    testing: params.testing,
    ...(wsAgent ? { wsAgent } : {}),
  });
}
