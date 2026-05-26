import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { weatherGuidance, WEATHER_GUIDANCE } from "../src/guidance.js";
import { classifyWeather, type OpenMeteoResponse } from "../src/weather.js";

const cfg = normalizeConfig({});

// ---------------------------------------------------------------------------
// classifyWeather — WMO code + temperature classification
// ---------------------------------------------------------------------------

describe("classifyWeather", () => {
  it("returns 'hot' when temperature exceeds 30 °C", () => {
    expect(classifyWeather({ current: { temperature_2m: 35, weather_code: 0 } })).toBe("hot");
  });

  it("returns 'cold' when temperature is below 5 °C", () => {
    expect(classifyWeather({ current: { temperature_2m: 2, weather_code: 0 } })).toBe("cold");
  });

  it("temperature extremes take priority over weather codes", () => {
    // 35 °C + rain code → still "hot" because temperature wins.
    expect(classifyWeather({ current: { temperature_2m: 35, weather_code: 61 } })).toBe("hot");
    // 0 °C + clear sky → still "cold" because temperature wins.
    expect(classifyWeather({ current: { temperature_2m: 0, weather_code: 0 } })).toBe("cold");
  });

  it("returns 'sunny' for WMO code 0 (clear sky) at moderate temp", () => {
    expect(classifyWeather({ current: { temperature_2m: 22, weather_code: 0 } })).toBe("sunny");
  });

  it("returns 'cloudy' for WMO codes 1, 2, 3, 45, 48", () => {
    for (const code of [1, 2, 3, 45, 48]) {
      expect(classifyWeather({ current: { temperature_2m: 20, weather_code: code } })).toBe(
        "cloudy",
      );
    }
  });

  it("returns 'rainy' for drizzle, rain, and rain shower codes", () => {
    for (const code of [51, 53, 55, 61, 63, 65, 80, 81, 82]) {
      expect(classifyWeather({ current: { temperature_2m: 15, weather_code: code } })).toBe(
        "rainy",
      );
    }
  });

  it("returns 'snowy' for snow fall and snow shower codes", () => {
    for (const code of [71, 73, 75, 85, 86]) {
      expect(classifyWeather({ current: { temperature_2m: 15, weather_code: code } })).toBe(
        "snowy",
      );
    }
  });

  it("returns 'stormy' for thunderstorm codes", () => {
    for (const code of [95, 96, 99]) {
      expect(classifyWeather({ current: { temperature_2m: 20, weather_code: code } })).toBe(
        "stormy",
      );
    }
  });

  it("returns 'neutral' when no data is available", () => {
    expect(classifyWeather({})).toBe("neutral");
    expect(classifyWeather({ current: {} })).toBe("neutral");
  });

  it("returns 'neutral' for moderate temp with an unknown WMO code", () => {
    expect(classifyWeather({ current: { temperature_2m: 20, weather_code: 999 } })).toBe(
      "neutral",
    );
  });

  it("handles missing temperature gracefully", () => {
    // No temperature but a valid weather code → use code.
    expect(classifyWeather({ current: { weather_code: 61 } })).toBe("rainy");
  });

  it("handles missing weather code gracefully", () => {
    // Temperature but no code → use temperature.
    expect(classifyWeather({ current: { temperature_2m: 35 } })).toBe("hot");
    // Moderate temperature, no code → neutral.
    expect(classifyWeather({ current: { temperature_2m: 20 } })).toBe("neutral");
  });
});

// ---------------------------------------------------------------------------
// weatherGuidance — mapping conditions to guidance text
// ---------------------------------------------------------------------------

describe("weatherGuidance", () => {
  it("returns undefined for 'neutral'", () => {
    expect(weatherGuidance("neutral")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(weatherGuidance(undefined)).toBeUndefined();
  });

  it("returns a guidance string for each non-neutral condition", () => {
    const conditions = ["sunny", "cloudy", "rainy", "snowy", "stormy", "hot", "cold"] as const;
    for (const condition of conditions) {
      const result = weatherGuidance(condition);
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result!.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic for the same condition (cache stability)", () => {
    expect(weatherGuidance("sunny")).toBe(weatherGuidance("sunny"));
    expect(weatherGuidance("rainy")).toBe(weatherGuidance("rainy"));
  });

  it("returns the correct guidance for each condition", () => {
    expect(weatherGuidance("sunny")).toBe(WEATHER_GUIDANCE.sunny);
    expect(weatherGuidance("rainy")).toBe(WEATHER_GUIDANCE.rainy);
    expect(weatherGuidance("stormy")).toBe(WEATHER_GUIDANCE.stormy);
  });

  it("sunny guidance mentions cheerful or energetic", () => {
    expect(weatherGuidance("sunny")?.toLowerCase()).toMatch(/cheerful|energetic/);
  });

  it("stormy guidance mentions reassuring or calm", () => {
    expect(weatherGuidance("stormy")?.toLowerCase()).toMatch(/reassuring|calm/);
  });

  it("hot guidance mentions cool or hydrated", () => {
    expect(weatherGuidance("hot")?.toLowerCase()).toMatch(/cool|hydrated/);
  });
});

// ---------------------------------------------------------------------------
// Weather config normalization
// ---------------------------------------------------------------------------

describe("weather config", () => {
  it("defaults weather to enabled with Berlin coordinates", () => {
    expect(cfg.weather.enabled).toBe(true);
    expect(cfg.weather.latitude).toBe(52.52);
    expect(cfg.weather.longitude).toBe(13.41);
  });

  it("respects custom coordinates", () => {
    const custom = normalizeConfig({ weather: { latitude: 48.85, longitude: 2.35 } });
    expect(custom.weather.latitude).toBe(48.85);
    expect(custom.weather.longitude).toBe(2.35);
  });

  it("can be disabled", () => {
    const disabled = normalizeConfig({ weather: { enabled: false } });
    expect(disabled.weather.enabled).toBe(false);
  });

  it("clamps latitude to [-90, 90]", () => {
    const clamped = normalizeConfig({ weather: { latitude: 200 } });
    expect(clamped.weather.latitude).toBe(90);
  });

  it("clamps longitude to [-180, 180]", () => {
    const clamped = normalizeConfig({ weather: { longitude: -999 } });
    expect(clamped.weather.longitude).toBe(-180);
  });
});
