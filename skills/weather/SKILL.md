---
name: weather
description: Get current weather and forecasts (no API key required).
homepage: https://wttr.in/:help
metadata: { "openclaw": { "emoji": "🌤️", "requires": { "bins": ["curl"] } } }
---

# Weather

Two free services, no API keys needed.

## wttr.in (primary)

Quick one-liner:

```bash
curl -s "wttr.in/London?format=3"
# Output: London: ⛅️ +8°C
```

Compact format:

```bash
curl -s "wttr.in/London?format=%l:+%c+%t+%h+%w"
# Output: London: ⛅️ +8°C 71% ↙5km/h
```

Full forecast:

```bash
curl -s "wttr.in/London?T"
```

Format codes: `%c` condition · `%t` temp · `%h` humidity · `%w` wind · `%l` location · `%m` moon

Tips:

- URL-encode spaces: `wttr.in/New+York`
- Airport codes: `wttr.in/JFK`
- Units: `?m` (metric) `?u` (USCS)
- Today only: `?1` · Current only: `?0`
- PNG: `curl -s "wttr.in/Berlin.png" -o /tmp/weather.png`

## Open-Meteo (fallback, JSON)

Free, no key, good for programmatic use:

```bash
curl -s "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&current_weather=true"
```

Find coordinates for a city, then query. Returns JSON with temp, windspeed, weathercode.

Docs: https://open-meteo.com/en/docs

## Precipitation: Always Cross-Check

**Never report `precipitation_probability_max` on its own.** It is frequently misleading -- the API can return high probability (e.g. 65%) with 0mm actual expected precipitation.

When checking rain, always request **both** fields:

```bash
curl -s "https://api.open-meteo.com/v1/forecast?latitude=19.43&longitude=-99.13&current_weather=true&daily=precipitation_probability_max,precipitation_sum&timezone=auto&forecast_days=1"
```

Then apply this logic:

| `precipitation_sum` | `precipitation_probability_max` | Interpretation |
|---|---|---|
| 0mm | Any value | **No rain.** Ignore the probability. |
| >0mm | High | Rain likely. Report both values. |
| >0mm | Low | Light/brief rain possible. Mention it. |

### Seasonal awareness

Some cities have pronounced dry/wet seasons where probability numbers are especially unreliable:

- **Mexico City**: Dry season Nov-Apr (essentially zero rain). Wet season May-Oct.
- **Mediterranean climates**: Dry summers, wet winters.
- **Monsoon regions**: Pronounced wet/dry cycles.

If `precipitation_sum` is 0mm during a known dry season, skip the rain mention entirely -- don't confuse users with phantom probabilities.
