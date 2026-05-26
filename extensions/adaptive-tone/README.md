# Adaptive Tone — an OpenClaw plugin

Adjusts an OpenClaw assistant's **conversational tone** based on context:

- **Time of day** — calmer, more concise late at night.
- **Channel ("place")** — more formal in work channels, more relaxed in personal ones.
- **Repetition** — more patient, and re-explains differently, when you ask the same thing again.
- **Stated wellbeing** — gentler and lower-demand when you say you're unwell or having a hard time.
- **Weather** — subtly adapts tone to local weather conditions (sunny → cheerful, rainy → cozy, stormy → calm and reassuring).

It does this by registering one OpenClaw lifecycle hook (`before_prompt_build`) and
appending short tone guidance to the system prompt for that turn. **No OpenClaw core
code is modified.**

## What this is — and isn't

This is **tone steering, not emotion.** The underlying model has no feelings; OpenClaw
is an orchestration harness that calls a model. This plugin only changes the
*instructions* the model receives so its replies *read* warmer, calmer, more patient,
or more formal depending on context. It never changes the facts, the assistant's
accuracy, its capabilities, or its safety behaviour.

The "gentler when unwell" feature **softens tone only**. It explicitly does *not* provide
medical, crisis, or therapeutic advice, and it never overrides the model's own safety
guidance. It is not a mental-health tool.

The "weather-aware tone" feature uses the free [Open-Meteo API](https://open-meteo.com/)
to fetch current conditions. Results are cached for 15 minutes, and any fetch failure
is silently ignored (fail-open), so weather never blocks or breaks a reply.

## How it works

| Stage | Where (in OpenClaw) |
|---|---|
| Base system prompt is built | `src/agents/pi-embedded-runner/system-prompt.ts` |
| This plugin's hook runs and appends tone guidance | `before_prompt_build`, fired in `src/agents/pi-embedded-runner/run/attempt.ts` |

The hook resolves the current context to exactly one **tone state**
(priority: `gentle-care` › `patient-repeat`/`patient-light` › `quiet-latenight` ›
`professional`/`casual` › `neutral`) and returns `appendSystemContext`. Weather
guidance is layered additively on top of whichever tone state is active.

The guidance string is a pure function of the state, so OpenClaw's prompt cache stays
warm until the context category actually changes.

## Install

```bash
# from a local checkout (development)
openclaw plugins install --link /path/to/openclaw-adaptive-tone

# from git, once you've pushed it
openclaw plugins install git:github.com/<you>/openclaw-adaptive-tone

openclaw plugins enable adaptive-tone
openclaw gateway restart
```

Verify it loaded:

```bash
openclaw plugins inspect adaptive-tone --runtime --json
```

## Configure

Settings live under `plugins.entries.adaptive-tone.config`. All fields are optional;
sensible defaults apply. Example:

```jsonc
{
  "enabled": true,
  "time": { "enabled": true, "timezone": "Europe/Berlin" },
  "place": {
    "enabled": true,
    "professionalChannels": ["slack", "teams"],
    "casualChannels": ["whatsapp", "telegram"]
  },
  "repetition": { "enabled": true, "windowTurns": 6, "similarityThreshold": 0.8 },
  "wellbeing": { "enabled": true },
  "weather": { "enabled": true, "latitude": 52.52, "longitude": 13.41 },
  "guidanceOverrides": {
    "casual": "Keep it breezy and use first names."
  }
}
```

Notes:

- **Timezone:** the hook context does not currently expose the user's timezone, so set
  `time.timezone` (IANA, e.g. `Europe/Berlin`) for correct late-night detection.
  Without it, the Gateway host's local time is used.
- **Disabling an axis:** set e.g. `wellbeing.enabled: false` to turn off just that
  signal while keeping the others.
- **Weather:** defaults to Berlin (52.52, 13.41). Set your own latitude/longitude for
  accurate local weather. The weather API is rate-limited to one call per 15 minutes.
  Disable with `weather.enabled: false`.
- **Overrides** must stay static (no per-turn data) to preserve prompt caching.

## Weather conditions

The weather signal maps [WMO weather codes](https://open-meteo.com/en/docs#weathervariables)
and temperature into these conditions:

| Condition | Trigger | Tone effect |
|---|---|---|
| ☀️ Sunny | WMO code 0 (clear sky) | Slightly more cheerful and energetic |
| ☁️ Cloudy | WMO codes 1–3, 45, 48 | Calm, focused, and steady |
| 🌧️ Rainy | WMO codes 51–65, 80–82 | Cozy, quiet, and reflective |
| ❄️ Snowy | WMO codes 71–75, 85–86 | Warm, cozy, and comforting |
| ⛈️ Stormy | WMO codes 95–99 | Reassuring, stable, and calm |
| 🔥 Hot | Temperature > 30 °C | Light, cool, and brief |
| 🥶 Cold | Temperature < 5 °C | Warm and comforting |

Temperature extremes (hot/cold) take priority over weather codes.

## Develop

```bash
npm install
npm run typecheck
npm test
```

Logic lives in `src/` as pure, dependency-free functions; `index.ts` wires them into the
hook. Tests cover signal detection, state priority, cache-stable guidance, and weather
classification.

## Project structure

```
index.ts          — Plugin entry: registers the before_prompt_build hook
src/
  config.ts       — Config types + normalization (mirrors openclaw.plugin.json schema)
  guidance.ts     — Maps tone states and weather conditions to guidance text
  signals.ts      — Pure signal detectors (time, channel, repetition, wellbeing)
  states.ts       — Priority-ordered tone state resolution
  weather.ts      — Open-Meteo API client with 15-minute cache
test/
  signals.test.ts — Signal detection tests
  states.test.ts  — State priority and guidance tests
  weather.test.ts — Weather classification, guidance, and config tests
```

## License

MIT — see [LICENSE](LICENSE).
