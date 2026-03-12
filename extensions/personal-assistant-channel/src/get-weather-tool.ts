import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/llm-task";
import {
  normalizeText,
  readPluginConfig,
  resolveTimeoutSignal,
  trimTrailingSlash,
} from "./plugin-config.js";

type GetWeatherToolContext = {
  sessionKey?: string;
};

type WeatherResponse = {
  error?: "location_not_found" | "location_unavailable";
  reason?: string;
  summary?: string;
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    timezone?: string;
  };
  forecast?: {
    date?: string;
    day?: "today" | "tomorrow";
    precipitation_probability_max?: number;
    temperature_max_c?: number;
    temperature_min_c?: number;
    weather_code?: number;
    weather_text?: string;
  };
};

export function getWeatherTool(api: OpenClawPluginApi, ctx: GetWeatherToolContext) {
  return {
    name: "get_weather",
    label: "Get Weather",
    description:
      "Get today's or tomorrow's weather for the current user, using the provided city or the app's current location when available.",
    parameters: Type.Object({
      day: Type.Optional(
        Type.Union([Type.Literal("today"), Type.Literal("tomorrow")], {
          description: "Which day to check. Defaults to today.",
        }),
      ),
      location: Type.Optional(
        Type.String({
          description: "Optional city or location name. Omit it to use the app's current location.",
          minLength: 1,
          maxLength: 80,
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const sessionKey = normalizeText(ctx.sessionKey);

      if (!sessionKey) {
        throw new Error("get_weather requires an active session");
      }

      const day = normalizeDay(params.day) ?? "today";
      const location = normalizeText(params.location);
      const pluginConfig = readPluginConfig(api);

      if (!pluginConfig.assistantApiBaseUrl) {
        throw new Error("personal-assistant-channel missing assistantApiBaseUrl");
      }

      if (!pluginConfig.assistantApiToken) {
        throw new Error("personal-assistant-channel missing assistantApiToken");
      }

      const timeoutMs = pluginConfig.requestTimeoutMs ?? 30_000;
      const response = await requestWeather({
        assistantApiBaseUrl: pluginConfig.assistantApiBaseUrl,
        assistantApiToken: pluginConfig.assistantApiToken,
        day,
        location,
        sessionKey,
        timeoutMs,
      });

      if (response.error === "location_unavailable") {
        return {
          content: [
            {
              type: "text",
              text: "当前没有可用位置信息。请让用户授权当前位置，或直接告诉你想查哪个城市。",
            },
          ],
          details: {
            needsUserLocation: true,
            reason: response.reason ?? null,
          },
        };
      }

      if (response.error === "location_not_found") {
        const locationHint = location ? `「${location}」` : "这个地点";

        return {
          content: [
            {
              type: "text",
              text: `没有找到${locationHint}。请让用户换一个更明确的城市或地区名称。`,
            },
          ],
          details: {
            locationNotFound: true,
          },
        };
      }

      if (!response.summary) {
        throw new Error("weather response missing summary");
      }

      return {
        content: [{ type: "text", text: response.summary }],
        details: response,
      };
    },
  };
}

async function requestWeather(params: {
  assistantApiBaseUrl: string;
  assistantApiToken: string;
  day: "today" | "tomorrow";
  location?: string;
  sessionKey: string;
  timeoutMs: number;
}): Promise<WeatherResponse> {
  const response = await fetch(
    `${trimTrailingSlash(params.assistantApiBaseUrl)}/api/internal/openclaw/weather`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.assistantApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_key: params.sessionKey,
        day: params.day,
        location: params.location,
      }),
      signal: resolveTimeoutSignal(params.timeoutMs),
    },
  );

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (response.status === 404 && payload.error === "location_not_found") {
    return { error: "location_not_found" };
  }

  if (response.status === 409 && payload.error === "location_unavailable") {
    return {
      error: "location_unavailable",
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
    };
  }

  if (!response.ok) {
    const message =
      typeof payload.details === "string"
        ? payload.details
        : typeof payload.error === "string"
          ? payload.error
          : `assistant api responded ${response.status}`;

    throw new Error(message);
  }

  return payload as WeatherResponse;
}

function normalizeDay(value: unknown): "today" | "tomorrow" | undefined {
  if (value === "today" || value === "tomorrow") {
    return value;
  }

  return undefined;
}
