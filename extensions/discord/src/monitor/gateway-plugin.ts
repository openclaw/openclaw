import { ListenerEvent } from "@buape/carbon/dist/src/types/index.js";
import * as carbonGateway from "@buape/carbon/gateway";
import type { APIGatewayBotInfo } from "discord-api-types/v10";
import * as httpsProxyAgent from "https-proxy-agent";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import * as undici from "undici";
import * as ws from "ws";
import { validateDiscordProxyUrl } from "../proxy-fetch.js";

const DISCORD_GATEWAY_BOT_URL = "https://discord.com/api/v10/gateway/bot";
const DEFAULT_DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/";
const DISCORD_GATEWAY_INFO_TIMEOUT_MS = 10_000;

type DiscordGatewayMetadataResponse = Pick<Response, "ok" | "status" | "text">;
type DiscordGatewayFetchInit = Record<string, unknown> & {
  headers?: Record<string, string>;
};
type DiscordGatewayFetch = (
  input: string,
  init?: DiscordGatewayFetchInit,
) => Promise<DiscordGatewayMetadataResponse>;

type DiscordGatewayMetadataError = Error & { transient?: boolean };
type DiscordGatewayWebSocketCtor = new (url: string, options?: { agent?: unknown }) => ws.WebSocket;

function normalizeGatewayMessageData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString();
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString();
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString();
  }
  return String(data);
}

export function resolveDiscordGatewayIntents(
  intentsConfig?: import("openclaw/plugin-sdk/config-runtime").DiscordIntentsConfig,
): number {
  let intents =
    carbonGateway.GatewayIntents.Guilds |
    carbonGateway.GatewayIntents.GuildMessages |
    carbonGateway.GatewayIntents.MessageContent |
    carbonGateway.GatewayIntents.DirectMessages |
    carbonGateway.GatewayIntents.GuildMessageReactions |
    carbonGateway.GatewayIntents.DirectMessageReactions |
    carbonGateway.GatewayIntents.GuildVoiceStates;
  if (intentsConfig?.presence) {
    intents |= carbonGateway.GatewayIntents.GuildPresences;
  }
  if (intentsConfig?.guildMembers) {
    intents |= carbonGateway.GatewayIntents.GuildMembers;
  }
  return intents;
}

function summarizeGatewayResponseBody(body: string): string {
  const normalized = body.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "<empty>";
  }
  return normalized.slice(0, 240);
}

function isTransientDiscordGatewayResponse(status: number, body: string): boolean {
  if (status >= 500) {
    return true;
  }
  const normalized = normalizeLowercaseStringOrEmpty(body);
  return (
    normalized.includes("upstream connect error") ||
    normalized.includes("disconnect/reset before headers") ||
    normalized.includes("reset reason:")
  );
}

function createGatewayMetadataError(params: {
  detail: string;
  transient: boolean;
  cause?: unknown;
}): Error {
  const error = new Error(
    params.transient
      ? "Failed to get gateway information from Discord: fetch failed"
      : `Failed to get gateway information from Discord: ${params.detail}`,
    {
      cause: params.cause ?? (params.transient ? new Error(params.detail) : undefined),
    },
  ) as DiscordGatewayMetadataError;
  Object.defineProperty(error, "transient", {
    value: params.transient,
    enumerable: false,
  });
  return error;
}

function isTransientGatewayMetadataError(error: unknown): boolean {
  return Boolean((error as DiscordGatewayMetadataError | undefined)?.transient);
}

function createDefaultGatewayInfo(): APIGatewayBotInfo {
  return {
    url: DEFAULT_DISCORD_GATEWAY_URL,
    shards: 1,
    session_start_limit: {
      total: 1,
      remaining: 1,
      reset_after: 0,
      max_concurrency: 1,
    },
  };
}

async function fetchDiscordGatewayInfo(params: {
  token: string;
  fetchImpl: DiscordGatewayFetch;
  fetchInit?: DiscordGatewayFetchInit;
}): Promise<APIGatewayBotInfo> {
  let response: DiscordGatewayMetadataResponse;
  try {
    response = await params.fetchImpl(DISCORD_GATEWAY_BOT_URL, {
      ...params.fetchInit,
      headers: {
        ...params.fetchInit?.headers,
        Authorization: `Bot ${params.token}`,
      },
    });
  } catch (error) {
    throw createGatewayMetadataError({
      detail: formatErrorMessage(error),
      transient: true,
      cause: error,
    });
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw createGatewayMetadataError({
      detail: formatErrorMessage(error),
      transient: true,
      cause: error,
    });
  }
  const summary = summarizeGatewayResponseBody(body);
  const transient = isTransientDiscordGatewayResponse(response.status, body);

  if (!response.ok) {
    throw createGatewayMetadataError({
      detail: `Discord API /gateway/bot failed (${response.status}): ${summary}`,
      transient,
    });
  }

  try {
    const parsed = JSON.parse(body) as Partial<APIGatewayBotInfo>;
    return {
      ...parsed,
      url:
        typeof parsed.url === "string" && parsed.url.trim()
          ? parsed.url
          : DEFAULT_DISCORD_GATEWAY_URL,
    } as APIGatewayBotInfo;
  } catch (error) {
    throw createGatewayMetadataError({
      detail: `Discord API /gateway/bot returned invalid JSON: ${summary}`,
      transient,
      cause: error,
    });
  }
}

async function fetchDiscordGatewayInfoWithTimeout(params: {
  token: string;
  fetchImpl: DiscordGatewayFetch;
  fetchInit?: DiscordGatewayFetchInit;
  timeoutMs?: number;
}): Promise<APIGatewayBotInfo> {
  const timeoutMs = Math.max(1, params.timeoutMs ?? DISCORD_GATEWAY_INFO_TIMEOUT_MS);
  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      reject(
        createGatewayMetadataError({
          detail: `Discord API /gateway/bot timed out after ${timeoutMs}ms`,
          transient: true,
          cause: new Error("gateway metadata timeout"),
        }),
      );
    }, timeoutMs);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([
      fetchDiscordGatewayInfo({
        token: params.token,
        fetchImpl: params.fetchImpl,
        fetchInit: {
          ...params.fetchInit,
          signal: abortController.signal,
        },
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function resolveGatewayInfoWithFallback(params: { runtime?: RuntimeEnv; error: unknown }): {
  info: APIGatewayBotInfo;
  usedFallback: boolean;
} {
  if (!isTransientGatewayMetadataError(params.error)) {
    throw params.error;
  }
  const message = formatErrorMessage(params.error);
  params.runtime?.log?.(
    `discord: gateway metadata lookup failed transiently; using default gateway url (${message})`,
  );
  return {
    info: createDefaultGatewayInfo(),
    usedFallback: true,
  };
}

function createGatewayPlugin(params: {
  options: {
    reconnect: { maxAttempts: number };
    intents: number;
    autoInteractions: boolean;
  };
  fetchImpl: DiscordGatewayFetch;
  fetchInit?: DiscordGatewayFetchInit;
  wsAgent?: InstanceType<typeof httpsProxyAgent.HttpsProxyAgent<string>>;
  runtime?: RuntimeEnv;
  testing?: {
    registerClient?: (
      plugin: carbonGateway.GatewayPlugin,
      client: Parameters<carbonGateway.GatewayPlugin["registerClient"]>[0],
    ) => Promise<void>;
    webSocketCtor?: DiscordGatewayWebSocketCtor;
  };
}): carbonGateway.GatewayPlugin {
  class SafeGatewayPlugin extends carbonGateway.GatewayPlugin {
    private gatewayInfoUsedFallback = false;

    constructor() {
      super(params.options);
    }

    override async registerClient(
      client: Parameters<carbonGateway.GatewayPlugin["registerClient"]>[0],
    ) {
      if (!this.gatewayInfo || this.gatewayInfoUsedFallback) {
        const resolved = await fetchDiscordGatewayInfoWithTimeout({
          token: client.options.token,
          fetchImpl: params.fetchImpl,
          fetchInit: params.fetchInit,
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
      return super.registerClient(client);
    }

    override createWebSocket(url: string) {
      if (!url) {
        throw new Error("Gateway URL is required");
      }
      // Avoid Node's undici-backed global WebSocket here. We have seen late
      // close-path crashes during Discord gateway teardown; the ws transport is
      // already our proxy path and behaves predictably for lifecycle cleanup.
      const WebSocketCtor = params.testing?.webSocketCtor ?? ws.default;
      const socket = new WebSocketCtor(url, params.wsAgent ? { agent: params.wsAgent } : undefined);
      if ("binaryType" in socket) {
        try {
          socket.binaryType = "arraybuffer";
        } catch {
          // Ignore runtimes that expose a readonly binaryType.
        }
      }
      return socket;
    }

    protected override setupWebSocket(): void {
      if (!this.ws) {
        return;
      }
      let closed = false;
      const state = this as typeof this & {
        isConnecting: boolean;
        reconnectAttempts: number;
      };

      this.ws.on("open", () => {
        state.isConnecting = false;
        state.reconnectAttempts = 0;
        this.emitter.emit("debug", "WebSocket connection opened");
      });
      this.ws.on("message", (data) => {
        this.monitor.recordMessageReceived();
        const payload = carbonGateway.validatePayload(normalizeGatewayMessageData(data));
        if (!payload) {
          this.monitor.recordError();
          this.emitter.emit("error", new Error("Invalid gateway payload received"));
          return;
        }
        const { op, d, s, t } = payload;
        if (s !== null && s !== undefined) {
          this.sequence = s;
          this.state.sequence = s;
        }
        switch (op) {
          case carbonGateway.GatewayOpcodes.Hello: {
            const helloData = d;
            const interval = helloData.heartbeat_interval;
            carbonGateway.startHeartbeat(this, {
              interval,
              reconnectCallback: () => {
                if (closed) {
                  this.emitter.emit(
                    "debug",
                    "Ignoring zombie reconnect for an already-closed gateway connection",
                  );
                  return;
                }
                closed = true;
                this.handleZombieConnection();
              },
            });
            if (this.canResume()) {
              this.resume();
            } else {
              this.identify();
            }
            break;
          }
          case carbonGateway.GatewayOpcodes.HeartbeatAck: {
            this.lastHeartbeatAck = true;
            this.monitor.recordHeartbeatAck();
            const latency = this.monitor.getMetrics().latency;
            if (latency > 0) {
              this.pings.push(latency);
              if (this.pings.length > 10) {
                this.pings.shift();
              }
            }
            break;
          }
          case carbonGateway.GatewayOpcodes.Heartbeat: {
            this.lastHeartbeatAck = false;
            this.send({
              op: carbonGateway.GatewayOpcodes.Heartbeat,
              d: this.sequence,
            });
            break;
          }
          case carbonGateway.GatewayOpcodes.Dispatch: {
            const dispatchPayload = payload;
            const eventType = dispatchPayload.t;
            try {
              if (!Object.values(ListenerEvent).includes(eventType)) {
                break;
              }
              if (eventType === "READY") {
                const readyData = d;
                this.state.sessionId = readyData.session_id;
                this.state.resumeGatewayUrl = readyData.resume_gateway_url;
              }
              if (t && this.client) {
                if (!this.options.eventFilter || this.options.eventFilter?.(eventType)) {
                  if (eventType === "READY" || eventType === "RESUMED") {
                    this.isConnected = true;
                  }
                  if (eventType === "READY") {
                    const readyData = d;
                    readyData.guilds.forEach((guild: { id: string }) => {
                      this.babyCache.setGuild(guild.id, {
                        available: false,
                        lastEvent: Date.now(),
                      });
                    });
                  }
                  if (eventType === "GUILD_CREATE") {
                    const guildCreateData = d;
                    const existingGuild = this.babyCache.getGuild(guildCreateData.id);
                    if (existingGuild && !existingGuild.available) {
                      this.babyCache.setGuild(guildCreateData.id, {
                        available: true,
                        lastEvent: Date.now(),
                      });
                      this.client.eventHandler.handleEvent(
                        {
                          ...guildCreateData,
                          clientId: this.client.options.clientId,
                        },
                        "GUILD_AVAILABLE",
                      );
                      break;
                    }
                  }
                  if (eventType === "GUILD_DELETE") {
                    const guildDeleteData = d;
                    const existingGuild = this.babyCache.getGuild(guildDeleteData.id);
                    if (existingGuild?.available && guildDeleteData.unavailable) {
                      this.babyCache.setGuild(guildDeleteData.id, {
                        available: false,
                        lastEvent: Date.now(),
                      });
                      this.client.eventHandler.handleEvent(
                        {
                          ...guildDeleteData,
                          clientId: this.client.options.clientId,
                        },
                        "GUILD_UNAVAILABLE",
                      );
                      break;
                    }
                  }
                  this.client.eventHandler.handleEvent(
                    {
                      ...dispatchPayload.d,
                      clientId: this.client.options.clientId,
                    },
                    eventType,
                  );
                }
              }
            } catch (err) {
              console.error(err);
            }
            break;
          }
          case carbonGateway.GatewayOpcodes.InvalidSession: {
            const canResume = Boolean(d);
            setTimeout(() => {
              closed = true;
              if (canResume && this.canResume()) {
                this.connect(true);
              } else {
                this.state.sessionId = null;
                this.state.resumeGatewayUrl = null;
                this.state.sequence = null;
                this.sequence = null;
                this.pings = [];
                this.connect(false);
              }
            }, 5000);
            break;
          }
          case carbonGateway.GatewayOpcodes.Reconnect:
            if (closed) {
              this.emitter.emit(
                "debug",
                "Ignoring gateway reconnect opcode for an already-closed connection",
              );
              break;
            }
            closed = true;
            this.state.sequence = this.sequence;
            this.ws?.close();
            this.handleReconnect();
            break;
        }
      });
      this.ws.on("close", (code) => {
        state.isConnecting = false;
        this.emitter.emit("debug", `WebSocket connection closed with code ${code}`);
        this.monitor.recordReconnect();
        if (closed) {
          return;
        }
        closed = true;
        this.handleClose(code);
      });
      this.ws.on("error", (error) => {
        state.isConnecting = false;
        this.monitor.recordError();
        this.emitter.emit("error", error);
      });
    }
  }

  return new SafeGatewayPlugin();
}

export function createDiscordGatewayPlugin(params: {
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv;
  __testing?: {
    HttpsProxyAgentCtor?: typeof httpsProxyAgent.HttpsProxyAgent;
    ProxyAgentCtor?: typeof undici.ProxyAgent;
    undiciFetch?: typeof undici.fetch;
    webSocketCtor?: DiscordGatewayWebSocketCtor;
    registerClient?: (
      plugin: carbonGateway.GatewayPlugin,
      client: Parameters<carbonGateway.GatewayPlugin["registerClient"]>[0],
    ) => Promise<void>;
  };
}): carbonGateway.GatewayPlugin {
  const intents = resolveDiscordGatewayIntents(params.discordConfig?.intents);
  const proxy = params.discordConfig?.proxy?.trim();
  const options = {
    reconnect: { maxAttempts: 50 },
    intents,
    autoInteractions: true,
  };

  if (!proxy) {
    return createGatewayPlugin({
      options,
      fetchImpl: (input, init) => fetch(input, init as RequestInit),
      runtime: params.runtime,
      testing: params.__testing
        ? {
            registerClient: params.__testing.registerClient,
            webSocketCtor: params.__testing.webSocketCtor,
          }
        : undefined,
    });
  }

  try {
    validateDiscordProxyUrl(proxy);
    const HttpsProxyAgentCtor =
      params.__testing?.HttpsProxyAgentCtor ?? httpsProxyAgent.HttpsProxyAgent;
    const ProxyAgentCtor = params.__testing?.ProxyAgentCtor ?? undici.ProxyAgent;
    const wsAgent = new HttpsProxyAgentCtor<string>(proxy);
    const fetchAgent = new ProxyAgentCtor(proxy);

    params.runtime.log?.("discord: gateway proxy enabled");

    return createGatewayPlugin({
      options,
      fetchImpl: (input, init) => (params.__testing?.undiciFetch ?? undici.fetch)(input, init),
      fetchInit: { dispatcher: fetchAgent },
      wsAgent,
      runtime: params.runtime,
      testing: params.__testing
        ? {
            registerClient: params.__testing.registerClient,
            webSocketCtor: params.__testing.webSocketCtor,
          }
        : undefined,
    });
  } catch (err) {
    params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
    return createGatewayPlugin({
      options,
      fetchImpl: (input, init) => fetch(input, init as RequestInit),
      runtime: params.runtime,
      testing: params.__testing
        ? {
            registerClient: params.__testing.registerClient,
            webSocketCtor: params.__testing.webSocketCtor,
          }
        : undefined,
    });
  }
}
