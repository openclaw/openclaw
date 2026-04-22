---
name: weather
description: "Get current weather, rain, temperature, and forecasts for locations or travel planning."
homepage: https://wttr.in/:help
metadata:
  {
    "openclaw":
      {
        "emoji": "☔",
        "requires": { "bins": ["curl"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "curl",
              "bins": ["curl"],
              "label": "Install curl (brew)",
            },
          ],
      },
  }
---

# Weather Skill

Get current weather conditions and forecasts.

## When to Use

✅ **USE this skill when:**

- "What's the weather?"
- "Will it rain today/tomorrow?"
- "Temperature in [city]"
- "Weather forecast for the week"
- Travel planning weather checks

## When NOT to Use

❌ **DON'T use this skill when:**

- Historical weather data → use weather archives/APIs
- Climate analysis or trends → use specialized data sources
- Hyper-local microclimate data → use local sensors
- Severe weather alerts → check official NWS sources
- Aviation/marine weather → use specialized services (METAR, etc.)

## Location

Always include a city, region, or airport code in weather queries.

## Units

**Always use metric (°C, km/h, mm).** Add `&m` to all wttr.in requests. The server is US-hosted so the default is Fahrenheit — never omit `&m`.

## Commands

### Current Weather

```bash
# One-line summary
curl "wttr.in/London?format=3&m"

# Detailed current conditions
curl "wttr.in/London?0&m"

# Specific city
curl "wttr.in/New+York?format=3&m"
```

### Forecasts

```bash
# 3-day forecast
curl "wttr.in/London?m"

# Week forecast
curl "wttr.in/London?format=v2&m"

# Specific day (0=today, 1=tomorrow, 2=day after)
curl "wttr.in/London?1&m"
```

### Format Options

```bash
# One-liner
curl "wttr.in/London?format=%l:+%c+%t+%w&m"

# JSON output (use lang param for metric in JSON)
curl "wttr.in/London?format=j1&m"

# PNG image
curl "wttr.in/London.png"
```

### Format Codes

- `%c` — Weather condition emoji
- `%t` — Temperature
- `%f` — "Feels like"
- `%w` — Wind
- `%h` — Humidity
- `%p` — Precipitation
- `%l` — Location

## Quick Responses

**"What's the weather?"**

```bash
curl -s "wttr.in/London?format=%l:+%c+%t+(feels+like+%f),+%w+wind,+%h+humidity&m"
```

**"Will it rain?"**

```bash
curl -s "wttr.in/London?format=%l:+%c+%p&m"
```

**"Weekend forecast"**

```bash
curl "wttr.in/London?format=v2&m"
```

## Notes

- No API key needed (uses wttr.in)
- Rate limited; don't spam requests
- Works for most global cities
- Supports airport codes: `curl wttr.in/ORD`
