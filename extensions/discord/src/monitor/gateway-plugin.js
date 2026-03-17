import { GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import WebSocket from "ws";
import { danger } from "../../../../src/globals.js";
const DISCORD_GATEWAY_BOT_URL = "https://discord.com/api/v10/gateway/bot";
const DEFAULT_DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/";
function resolveDiscordGatewayIntents(intentsConfig) {
  let intents = GatewayIntents.Guilds | GatewayIntents.GuildMessages | GatewayIntents.MessageContent | GatewayIntents.DirectMessages | GatewayIntents.GuildMessageReactions | GatewayIntents.DirectMessageReactions | GatewayIntents.GuildVoiceStates;
  if (intentsConfig?.presence) {
    intents |= GatewayIntents.GuildPresences;
  }
  if (intentsConfig?.guildMembers) {
    intents |= GatewayIntents.GuildMembers;
  }
  return intents;
}
function summarizeGatewayResponseBody(body) {
  const normalized = body.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "<empty>";
  }
  return normalized.slice(0, 240);
}
function isTransientDiscordGatewayResponse(status, body) {
  if (status >= 500) {
    return true;
  }
  const normalized = body.toLowerCase();
  return normalized.includes("upstream connect error") || normalized.includes("disconnect/reset before headers") || normalized.includes("reset reason:");
}
function createGatewayMetadataError(params) {
  if (params.transient) {
    return new Error("Failed to get gateway information from Discord: fetch failed", {
      cause: params.cause ?? new Error(params.detail)
    });
  }
  return new Error(`Failed to get gateway information from Discord: ${params.detail}`, {
    cause: params.cause
  });
}
async function fetchDiscordGatewayInfo(params) {
  let response;
  try {
    response = await params.fetchImpl(DISCORD_GATEWAY_BOT_URL, {
      ...params.fetchInit,
      headers: {
        ...params.fetchInit?.headers,
        Authorization: `Bot ${params.token}`
      }
    });
  } catch (error) {
    throw createGatewayMetadataError({
      detail: error instanceof Error ? error.message : String(error),
      transient: true,
      cause: error
    });
  }
  let body;
  try {
    body = await response.text();
  } catch (error) {
    throw createGatewayMetadataError({
      detail: error instanceof Error ? error.message : String(error),
      transient: true,
      cause: error
    });
  }
  const summary = summarizeGatewayResponseBody(body);
  const transient = isTransientDiscordGatewayResponse(response.status, body);
  if (!response.ok) {
    throw createGatewayMetadataError({
      detail: `Discord API /gateway/bot failed (${response.status}): ${summary}`,
      transient
    });
  }
  try {
    const parsed = JSON.parse(body);
    return {
      ...parsed,
      url: typeof parsed.url === "string" && parsed.url.trim() ? parsed.url : DEFAULT_DISCORD_GATEWAY_URL
    };
  } catch (error) {
    throw createGatewayMetadataError({
      detail: `Discord API /gateway/bot returned invalid JSON: ${summary}`,
      transient,
      cause: error
    });
  }
}
function createGatewayPlugin(params) {
  class SafeGatewayPlugin extends GatewayPlugin {
    constructor() {
      super(params.options);
    }
    async registerClient(client) {
      if (!this.gatewayInfo) {
        this.gatewayInfo = await fetchDiscordGatewayInfo({
          token: client.options.token,
          fetchImpl: params.fetchImpl,
          fetchInit: params.fetchInit
        });
      }
      return super.registerClient(client);
    }
    createWebSocket(url) {
      if (!params.wsAgent) {
        return super.createWebSocket(url);
      }
      return new WebSocket(url, { agent: params.wsAgent });
    }
  }
  return new SafeGatewayPlugin();
}
function createDiscordGatewayPlugin(params) {
  const intents = resolveDiscordGatewayIntents(params.discordConfig?.intents);
  const proxy = params.discordConfig?.proxy?.trim();
  const options = {
    reconnect: { maxAttempts: 50 },
    intents,
    autoInteractions: true
  };
  if (!proxy) {
    return createGatewayPlugin({
      options,
      fetchImpl: (input, init) => fetch(input, init)
    });
  }
  try {
    const wsAgent = new HttpsProxyAgent(proxy);
    const fetchAgent = new ProxyAgent(proxy);
    params.runtime.log?.("discord: gateway proxy enabled");
    return createGatewayPlugin({
      options,
      fetchImpl: (input, init) => undiciFetch(input, init),
      fetchInit: { dispatcher: fetchAgent },
      wsAgent
    });
  } catch (err) {
    params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
    return createGatewayPlugin({
      options,
      fetchImpl: (input, init) => fetch(input, init)
    });
  }
}
export {
  createDiscordGatewayPlugin,
  resolveDiscordGatewayIntents
};
