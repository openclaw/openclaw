import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/llm-task";
import {
  normalizeText,
  readPluginConfig,
  resolveTimeoutSignal,
  trimTrailingSlash,
} from "./plugin-config.js";

type ChannelResponse = {
  channel?: {
    id?: string;
    kind?: string;
    name?: string;
    primary_thread_id?: string;
  };
  created?: boolean;
  mode?: "created" | "existing" | "current";
};

type CreateChannelToolContext = {
  sessionKey?: string;
};

export function createChannelTool(api: OpenClawPluginApi, ctx: CreateChannelToolContext) {
  return {
    name: "create_channel",
    label: "Create Channel",
    description:
      "Create or reuse a named topic channel for the current user and switch the app to it.",
    parameters: Type.Object({
      name: Type.String({
        description: "Short topic name for the new channel.",
        minLength: 1,
        maxLength: 40,
      }),
      icon: Type.Optional(
        Type.String({
          description: "Optional icon or emoji for the topic channel.",
          minLength: 1,
          maxLength: 8,
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const sessionKey = normalizeText(ctx.sessionKey);

      if (!sessionKey) {
        throw new Error("create_channel requires an active session");
      }

      const name = normalizeText(params.name);

      if (!name) {
        throw new Error("name required");
      }

      const icon = normalizeText(params.icon);
      const pluginConfig = readPluginConfig(api);

      if (!pluginConfig.assistantApiBaseUrl) {
        throw new Error("personal-assistant-channel missing assistantApiBaseUrl");
      }

      if (!pluginConfig.assistantApiToken) {
        throw new Error("personal-assistant-channel missing assistantApiToken");
      }

      const timeoutMs = pluginConfig.requestTimeoutMs ?? 10_000;
      const response = await requestCreateChannel({
        assistantApiBaseUrl: pluginConfig.assistantApiBaseUrl,
        assistantApiToken: pluginConfig.assistantApiToken,
        sessionKey,
        name,
        icon,
        timeoutMs,
      });

      const channelName = response.channel?.name ?? name;
      const text =
        response.mode === "existing" || response.mode === "current"
          ? `已切换到主题「${channelName}」。`
          : `已创建主题「${channelName}」，并切换过去。`;

      return {
        content: [{ type: "text", text }],
        details: {
          channel: response.channel,
          created: response.created ?? false,
          mode: response.mode ?? (response.created ? "created" : "existing"),
        },
      };
    },
  };
}

async function requestCreateChannel(params: {
  assistantApiBaseUrl: string;
  assistantApiToken: string;
  sessionKey: string;
  name: string;
  icon?: string;
  timeoutMs: number;
}): Promise<ChannelResponse> {
  const response = await fetch(
    `${trimTrailingSlash(params.assistantApiBaseUrl)}/api/internal/openclaw/channels`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.assistantApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_key: params.sessionKey,
        name: params.name,
        icon: params.icon,
      }),
      signal: resolveTimeoutSignal(params.timeoutMs),
    },
  );

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const message =
      typeof payload.details === "string"
        ? payload.details
        : typeof payload.error === "string"
          ? payload.error
          : `assistant api responded ${response.status}`;

    throw new Error(message);
  }

  return payload as ChannelResponse;
}
