---
name: weather
description: Get current weather and forecasts (no API key required).
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

## Blake's Default Location

- **City:** Chicago, IL
- **Timezone:** America/Chicago (CST)
- Update if Blake mentions traveling

## Commands

### Current Weather
```bash
# Default location (Chicago)
curl "wttr.in/Chicago?format=3"

# Detailed current conditions
curl "wttr.in/Chicago?0"

# Specific city
curl "wttr.in/New+York?format=3"
```

### Forecasts
```bash
# 3-day forecast
curl "wttr.in/Chicago"

# Week forecast
curl "wttr.in/Chicago?format=v2"

# Specific day (0=today, 1=tomorrow, 2=day after)
curl "wttr.in/Chicago?1"
```

### Format Options
```bash
# One-liner
curl "wttr.in/Chicago?format=%l:+%c+%t+%w"

# JSON output
curl "wttr.in/Chicago?format=j1"

# PNG image
curl "wttr.in/Chicago.png"
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
curl -s "wttr.in/Chicago?format=%l:+%c+%t+(feels+like+%f),+%w+wind,+%h+humidity"
```

**"Will it rain?"**
```bash
curl -s "wttr.in/Chicago?format=j1" | jq '.weather[0].hourly[].chanceofrain'
```

**"Weekend forecast"**
```bash
curl "wttr.in/Chicago?format=v2"
```

## Notes

- No API key needed (uses wttr.in)
- Rate limited; don't spam requests
- Works for most global cities
- Supports airport codes: `curl wttr.in/ORD`
