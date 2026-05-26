/**
 * Weather signal detection via the Open-Meteo API.
 *
 * Pure functions live alongside a thin fetch wrapper with a 15-minute in-memory
 * cache. The cache keeps API traffic minimal (one call per quarter-hour at most)
 * and the fetch is fail-open: any network or parse error silently returns the
 * last known value (or `undefined` on first failure), so weather never blocks or
 * breaks a reply.
 *
 * WMO Weather Interpretation Codes (WW) reference:
 *   https://open-meteo.com/en/docs#weathervariables
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of the Open-Meteo `/v1/forecast` response we actually use. */
export interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    weather_code?: number;
  };
}

/** The weather conditions we map to tone guidance. */
export type WeatherCondition =
  | "sunny"
  | "cloudy"
  | "rainy"
  | "snowy"
  | "stormy"
  | "hot"
  | "cold"
  | "neutral";

// ---------------------------------------------------------------------------
// WMO code → condition mapping
// ---------------------------------------------------------------------------

/** WMO weather codes that indicate rain (drizzle, rain, rain showers). */
const RAIN_CODES = new Set([51, 53, 55, 61, 63, 65, 80, 81, 82]);
/** WMO weather codes that indicate snow (snow fall, snow showers). */
const SNOW_CODES = new Set([71, 73, 75, 85, 86]);
/** WMO weather codes that indicate thunderstorm. */
const STORM_CODES = new Set([95, 96, 99]);
/** WMO weather code for clear sky. */
const CLEAR_CODES = new Set([0]);
/** WMO weather codes for mainly clear, partly cloudy, overcast, fog, rime fog. */
const CLOUDY_CODES = new Set([1, 2, 3, 45, 48]);

/**
 * Classify an Open-Meteo response into a weather condition.
 *
 * Temperature extremes take priority: >30 °C → "hot", <5 °C → "cold".
 * Otherwise, WMO weather codes decide the condition. If nothing matches (or
 * data is missing), returns "neutral".
 */
export function classifyWeather(data: OpenMeteoResponse): WeatherCondition {
  const temp = data.current?.temperature_2m;
  const code = data.current?.weather_code;

  // Temperature extremes take priority.
  if (temp !== undefined) {
    if (temp > 30) return "hot";
    if (temp < 5) return "cold";
  }

  // Then classify by WMO weather code.
  if (code !== undefined) {
    if (RAIN_CODES.has(code)) return "rainy";
    if (SNOW_CODES.has(code)) return "snowy";
    if (STORM_CODES.has(code)) return "stormy";
    if (CLEAR_CODES.has(code)) return "sunny";
    if (CLOUDY_CODES.has(code)) return "cloudy";
  }

  return "neutral";
}

// ---------------------------------------------------------------------------
// Cached fetch
// ---------------------------------------------------------------------------

/** In-memory cache: one entry, refreshed every 15 minutes. */
let cachedCondition: WeatherCondition | undefined;
let lastFetchTime = 0;

/** Cache TTL in milliseconds (15 minutes). */
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Fetch the current weather condition for the given coordinates.
 *
 * Results are cached for 15 minutes to avoid excessive API calls. On any
 * failure the last cached value is returned (fail-open), so this function
 * never throws.
 */
export async function fetchWeatherCondition(
  lat: number,
  lon: number,
): Promise<WeatherCondition | undefined> {
  const now = Date.now();

  if (cachedCondition && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedCondition;
  }

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&current=weather_code,temperature_2m`;

    const res = await fetch(url);
    if (!res.ok) return cachedCondition;

    const data = (await res.json()) as OpenMeteoResponse;
    cachedCondition = classifyWeather(data);
    lastFetchTime = now;
    return cachedCondition;
  } catch {
    // Fail open: a weather fetch must never block or break a reply.
    return cachedCondition;
  }
}

/**
 * Reset the weather cache. Exposed for testing only — production code should
 * not call this.
 */
export function _resetCacheForTesting(): void {
  cachedCondition = undefined;
  lastFetchTime = 0;
}
