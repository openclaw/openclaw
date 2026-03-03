import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";

type WeatherCondition = "sunny" | "cloudy" | "rainy" | "windy" | "stormy" | "snowy" | "foggy";

type FakeWeatherResult = {
  city: string;
  condition: WeatherCondition;
  temperatureC: number;
  humidityPercent: number;
  windKph: number;
};

const CONDITIONS: WeatherCondition[] = [
  "sunny",
  "cloudy",
  "rainy",
  "windy",
  "stormy",
  "snowy",
  "foggy",
];

function hash(input: string): number {
  // Stable hash so same city gives consistent fake weather.
  let value = 0;
  for (const ch of input) {
    value = (value * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return value;
}

function pickCondition(seed: number): WeatherCondition {
  return CONDITIONS[seed % CONDITIONS.length] ?? "sunny";
}

function fakeWeather(cityRaw: string): FakeWeatherResult {
  const city = cityRaw.trim();
  const seed = hash(city.toLowerCase());
  return {
    city,
    condition: pickCondition(seed),
    temperatureC: (seed % 36) - 5,
    humidityPercent: 30 + (seed % 61),
    windKph: 2 + (seed % 39),
  };
}

function formatWeather(result: FakeWeatherResult): string {
  return [
    `🌤️ Fake weather for ${result.city}`,
    `- Condition: ${result.condition}`,
    `- Temperature: ${result.temperatureC}°C`,
    `- Humidity: ${result.humidityPercent}%`,
    `- Wind: ${result.windKph} km/h`,
    "",
    "(demo data only; not real weather)",
  ].join("\n");
}

function readCity(params: unknown): string | null {
  if (!params || typeof params !== "object") {
    return null;
  }
  const record = params as Record<string, unknown>;
  const raw = record.city;
  if (typeof raw !== "string") {
    return null;
  }
  const city = raw.trim();
  return city ? city : null;
}

export function createWeatherFakeTool(): AnyAgentTool {
  return {
    name: "weather_fake_1",
    description:
      "Return deterministic fake weather for a city. Tool-only demo endpoint (distinct from slash commands), never real meteorological data.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        city: {
          type: "string",
          description: "City name, for example 'Beijing' or 'San Francisco'.",
        },
      },
      required: ["city"],
    },
    async execute(_id, params) {
      const city = readCity(params);
      if (!city) {
        return {
          content: [{ type: "text", text: "city is required" }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: formatWeather(fakeWeather(city)) }],
      };
    },
  };
}

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createWeatherFakeTool());
}