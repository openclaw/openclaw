import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

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

export default function register(api: OpenClawPluginApi) {
  api.registerCommand({
    name: "weather",
    description: "Show fake weather for a city (demo).",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = (ctx.args ?? "").trim();
      if (!args) {
        return { text: "Usage: /weather <city>" };
      }
      return { text: formatWeather(fakeWeather(args)) };
    },
  });
}