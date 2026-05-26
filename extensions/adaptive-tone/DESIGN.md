# Adaptive Tone — design document

An OpenClaw plugin that adjusts the assistant's **conversational tone** based on
context: time of day, which channel ("place") the message came from, whether the
user has asked the same thing repeatedly, and whether the user has signalled they
are unwell or distressed.

- **Status:** design draft (no code yet)
- **Target:** OpenClaw plugin, distributed as its own package/repo
- **Author:** Vishal Nair Vijayan Pillai
- **Date:** 2026-05-25

---

## 1. Motivation

Out of the box, an OpenClaw assistant answers in the same register every time:
ask a question, get an answer. Humans don't do that. The same person phrases a
reply differently at 02:00 than at 14:00, differently to a close friend than in a
work channel, differently when you're clearly frustrated (asked three times) than
when you're calm, and differently when you've just said you feel ill.

This plugin makes the assistant's tone **context-sensitive** along those axes,
without changing *what* it knows or *what* it can do — only *how* it phrases the
reply.

## 2. What this is — and is honestly not

This is **tone steering**, not emotion.

- The underlying model (GPT, Claude, Llama, etc.) has no feelings. It produces
  text. OpenClaw is only an orchestration harness that calls that model — it
  contains no "brain" to give emotions to.
- What we *can* do is change the instructions the model receives each turn, so the
  text it produces *reads* as more gentle, more patient, more concise, warmer, or
  more formal, depending on context.
- We will be explicit about this in the README. Over-claiming "emotional
  intelligence" would be misleading and, for the unwell/distress path, potentially
  harmful. We are steering register, not simulating a person.

This honest framing is also what makes the project defensible to OpenClaw
maintainers and to users.

## 3. Goals / non-goals

### Goals
- Adjust tone based on five signal families: **time**, **place** (channel),
  **repetition**, **stated wellbeing**, and **local weather**.
- Ship as a standalone plugin using OpenClaw's documented `before_prompt_build`
  hook. **Zero changes to OpenClaw core.**
- Be fully operator-configurable (enable/disable per axis, per channel, custom
  tone text) via the plugin `configSchema`.
- Respect prompt caching — only change injected guidance when the *tone category*
  changes, not every turn.
- Fail open and silent: any error in the plugin must never block a reply.

### Non-goals
- No persistent psychological profiling of the user.
- No medical, crisis, or therapeutic functionality. If distress is detected we
  soften tone only; we do **not** attempt counselling. (See §10 Safety.)
- No sentiment ML model in v1 — start with transparent, inspectable heuristics.
- No changes to model selection, tools, or routing.

## 4. Where it plugs into OpenClaw (verified against source)

OpenClaw builds each turn's prompt in two stages:

1. **Base system prompt** is composed in
   `src/agents/pi-embedded-runner/system-prompt.ts`
   (`buildEmbeddedSystemPrompt` → `buildConfiguredAgentSystemPrompt`). It already
   receives `runtimeInfo.channel`, `userTime`, and `userTimezone` — i.e. the
   "place" and "time" signals are *already in the system* — but it does not yet
   vary tone with them.

2. **Plugins amend the prompt** at one site:
   `src/agents/pi-embedded-runner/run/attempt.ts:3563` runs the
   `before_prompt_build` hook. Whatever a plugin returns is applied there:
   - `prependContext` / `appendContext` → glued onto the **user prompt** (per-turn
     token cost).
   - `prependSystemContext` / `appendSystemContext` → merged into the **system
     prompt** via `composeSystemPromptWithHookContext` (cacheable — cheap).
   - `systemPrompt` → full override.

   The hook contract is in `src/plugins/hook-before-agent-start.types.ts`
   (`PluginHookBeforePromptBuildEvent` / `...Result`) and the handler signature is
   in `src/plugins/hook-types.ts` (`PluginHookHandlerMap.before_prompt_build`).

**This plugin registers a single `before_prompt_build` handler and returns
`appendSystemContext`.** Nothing else in core is touched.

### What the hook gives us
From the event and context (`attempt.ts:3566-3589`):

| Field | Source | Used for |
|---|---|---|
| `event.prompt` | current user message | wellbeing detection, repetition key |
| `event.messages` | session history | repetition detection |
| `ctx.channelId` | `buildAgentHookContextChannelFields` | "place" |
| `ctx.sessionKey` / `ctx.sessionId` | session | repetition scoping, per-session state |
| `ctx.modelProviderId` / `ctx.modelId` | resolved model | optional tuning |
| `new Date()` (read in handler) | system clock | "time of day" |

## 5. Signal model (inputs)

Each signal produces a small, named value — never free-form.

### 5.1 Time of day
From `new Date()` evaluated in the user's timezone where available. Buckets:
`early-morning` (05–08), `day` (08–18), `evening` (18–22), `late-night` (22–05).
Late-night → gentler, more concise; day → neutral/efficient.

### 5.2 Place (channel)
From `ctx.channelId`. Operator maps channels to registers, e.g.
`slack/teams → professional`, `whatsapp/imessage/telegram → casual`,
`discord → casual`. Default `neutral` when unmapped.

### 5.3 Repetition
Hash a normalised form of `event.prompt` (lowercased, punctuation/whitespace
stripped, trimmed). Compare against the last *N* user turns in `event.messages`
(and/or a small per-`sessionKey` ring buffer). Count near-identical or
semantically-close repeats. 2nd ask → "be more patient / try a different
explanation"; 3rd+ → "acknowledge the repeat, slow down, check what's unclear."
v1 uses exact/normalised match + optional token-overlap (Jaccard) threshold;
embeddings are a v2 option.

### 5.4 Stated wellbeing
Keyword/phrase detection over `event.prompt` only (never history-mined for
profiling): phrases like "I'm not well", "I'm sick", "feeling awful",
"I'm exhausted", "had a rough day". Match → `unwell` flag.
**This is deliberately conservative** — only explicit, user-volunteered
statements, no inference from typos or punctuation. Localisable phrase lists.

### 5.5 Local weather
From a local cache/fetch of the Open-Meteo `/v1/forecast` API using configured latitude/longitude coordinates (defaulting to Berlin, 52.52/13.41). Buckets WMO codes and temperature extremes into: `sunny`, `cloudy`, `rainy`, `snowy`, `stormy`, `hot`, `cold`, and `neutral`. Results are cached in-memory for 15 minutes, failing open on any network or parse error.

## 6. Tone state model (output categories)

Signals resolve to exactly one **tone state**. A small fixed set keeps the
injected text stable (good for caching) and auditable:

| State | Trigger (priority order) | Tone guidance injected |
|---|---|---|
| `gentle-care` | wellbeing = unwell | Warm, brief, low-demand. Offer to keep it short. No pressure, no long lists. |
| `patient-repeat` | repetition ≥ 3 | Acknowledge they've asked before; re-explain differently; ask what's unclear. |
| `patient-light` | repetition = 2 | Slightly more patient; vary the explanation; avoid copy-paste. |
| `quiet-latenight` | time = late-night | Calmer, more concise, lower energy. |
| `professional` | place = professional channel | Crisp, formal, structured. |
| `casual` | place = casual channel | Relaxed, friendly, contractions ok. |
| `neutral` | nothing else fires | Default OpenClaw behaviour (inject nothing). |

**Priority:** wellbeing > repetition > time > place. Highest firing wins as the
*primary* state.

**Weather integration (Additive):** unlike the priority-ordered tone states above, weather guidance is *additive*. If a weather condition (e.g. `sunny`, `rainy`, `stormy`) is active, its guidance is layered on top of the resolved primary tone state (or injected directly if the primary tone state is `neutral`).

Each state and weather condition maps to a short, operator-overridable guidance string. Defaults live in code; `configSchema` lets operators replace any of them.

## 7. The caching tradeoff (important design constraint)

`appendSystemContext` is **cached** by providers (the SDK note at
`hook-before-agent-start.types.ts:37` explicitly recommends it for static plugin
guidance). If we emit *different* text every turn, we bust the cache every turn —
slower and more expensive.

**Design rule:** the injected string is a pure function of the *tone state*, not of
the raw signals. So as long as the user stays in, say, `casual`, the exact same
bytes are injected and the cache stays warm. The string only changes when the
*state* changes (casual → gentle-care). This bounds cache churn to genuine context
shifts.

Corollary: keep the guidance strings short and deterministic. No timestamps, no
per-turn counters inside the injected text.

## 8. Decision logic (pseudocode)

```ts
function resolveToneState(event, ctx, now, config): ToneState {
  if (config.wellbeing.enabled && detectUnwell(event.prompt, config))
    return "gentle-care";

  if (config.repetition.enabled) {
    const n = countRepeats(event.prompt, event.messages, ctx.sessionKey, config);
    if (n >= 3) return "patient-repeat";
    if (n === 2) return "patient-light";
  }

  if (config.time.enabled && timeBucket(now, ctx) === "late-night")
    return "quiet-latenight";

  if (config.place.enabled) {
    const reg = channelRegister(ctx.channelId, config);  // professional | casual | neutral
    if (reg === "professional") return "professional";
    if (reg === "casual") return "casual";
  }
  return "neutral";
}
```

The hook handler then:

```ts
api.on("before_prompt_build", async (event, ctx) => {
  try {
    const state = resolveToneState(event, ctx, new Date(), config);
    let guidance = toneGuidance(state, config);
    let weatherText: string | undefined = undefined;

    if (config.weather.enabled) {
      const condition = await fetchWeatherCondition(
        config.weather.latitude,
        config.weather.longitude,
      );
      weatherText = weatherGuidance(condition);
    }

    if (weatherText) {
      if (guidance) {
        // Strip existing footer, append weather instruction, re-add footer
        const baseGuidance = guidance.replace(`\n${FOOTER}`, "");
        guidance = `${baseGuidance}\n- ${weatherText}\n${FOOTER}`;
      } else {
        guidance = `${HEADER}\n- ${weatherText}\n${FOOTER}`;
      }
    }

    if (!guidance) return undefined;
    return { appendSystemContext: guidance };
  } catch (e) {
    api.logger.warn?.(`adaptive-tone: skipped (${e})`);
    return undefined; // fail open, never block
  }
});
```

## 9. Plugin package structure (mirrors `extensions/active-memory`)

```
openclaw-adaptive-tone/
├── openclaw.plugin.json     # manifest: id, name, description, activation, configSchema, uiHints
├── package.json             # name, version, deps on openclaw/plugin-sdk
├── index.ts                 # definePluginEntry({ register(api) { api.on(...) } })
├── src/
│   ├── signals.ts           # detectUnwell, countRepeats, timeBucket, channelRegister
│   ├── states.ts            # ToneState type, resolveToneState, toneGuidance
│   ├── weather.ts           # classifyWeather, fetchWeatherCondition
│   └── config.ts            # normalize + defaults
├── test/
│   ├── signals.test.ts      # signal detection tests
│   ├── states.test.ts       # tone state resolution tests
│   └── weather.test.ts      # weather classification and guidance tests
├── README.md                # honest framing, install, config
└── LICENSE                  # MIT (match OpenClaw)
```

### Entry shape (verified against `active-memory/index.ts:2909`)
```ts
import { definePluginEntry, type OpenClawPluginApi }
  from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "adaptive-tone",
  name: "Adaptive Tone",
  description: "Adjusts assistant tone by time, channel, repetition, and stated wellbeing.",
  register(api: OpenClawPluginApi) {
    const config = normalizeConfig(api.pluginConfig);
    api.on("before_prompt_build", (event, ctx) => { /* see §8 */ });
  },
});
```

### Manifest shape (verified against `active-memory/openclaw.plugin.json`)
```jsonc
{
  "id": "adaptive-tone",
  "activation": { "onStartup": true },
  "name": "Adaptive Tone",
  "description": "...",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean" },
      "time":       { "type": "object", "properties": { "enabled": {"type":"boolean"} } },
      "place":      { "type": "object", "properties": {
        "enabled": {"type":"boolean"},
        "professionalChannels": {"type":"array","items":{"type":"string"}},
        "casualChannels": {"type":"array","items":{"type":"string"}}
      }},
      "repetition": { "type": "object", "properties": {
        "enabled": {"type":"boolean"},
        "windowTurns": {"type":"integer","minimum":1,"maximum":10}
      }},
      "wellbeing":  { "type": "object", "properties": {
        "enabled": {"type":"boolean"},
        "phrases": {"type":"array","items":{"type":"string"}}
      }},
      "weather":    { "type": "object", "properties": {
        "enabled": {"type":"boolean"},
        "latitude": {"type":"number"},
        "longitude": {"type":"number"}
      }},
      "guidanceOverrides": { "type": "object" }   // state -> custom text
    }
  },
  "uiHints": { /* labels + help per field */ }
}
```

## 10. Privacy & safety

- **Wellbeing detection is sensitive.** Only explicit, user-volunteered phrases in
  the *current* message trigger it. No storage of "user was sad on date X." No
  cross-session profile.
- **Not a crisis tool.** The `gentle-care` guidance only softens tone. It must
  explicitly *not* instruct the model to give medical or mental-health advice. If
  we ever detect acute crisis language, the safe behaviour is to defer to the
  model's own safety training — we do not add capability here. Document this
  boundary loudly in the README.
- **Inspectable by design.** Tone states and their guidance strings are a small,
  readable table — an operator can see exactly what gets injected and when.
- **Off by default per axis** is an option worth considering for the wellbeing
  axis specifically, given its sensitivity.
- **No external calls.** Everything runs locally in-process; no telemetry.

## 11. Testing strategy

- Unit tests for each signal function (`detectUnwell`, `countRepeats`,
  `timeBucket`, `channelRegister`) with table-driven cases.
- Unit tests for weather classification (`classifyWeather`) mapping WMO codes and temperature thresholds to weather conditions.
- `resolveToneState` priority tests (wellbeing beats repetition beats time beats
  place; neutral fallthrough).
- Weather integration verification and cache stability test.
- Fail-open test: handler/fetching throwing internally returns `undefined`/cached value, never throws.

## 12. Milestones

1. **M0 — scaffold:** package, manifest, empty `before_prompt_build` returning
   `undefined`. Loads in OpenClaw without effect.
2. **M1 — place + time:** channel register + late-night. Easiest, lowest risk.
3. **M2 — repetition:** normalised-match repeat counter over session history.
4. **M3 — wellbeing:** conservative phrase detection + `gentle-care`, with safety
   doc.
5. **M4 — weather:** Open-Meteo cache-enabled integration for weather-aware tone adjustment.
6. **M5 — config + uiHints:** full operator control, overrides.
7. **M6 — tests + README:** cache-stability tests, weather tests, honest framing doc.
8. **M7 — publish:** own GitHub repo, MIT, optional ClawHub listing.

## 13. Open questions

- **Timezone source:** confirm whether the plugin can read the resolved
  `userTimezone` from `api`/`ctx`, or whether to fall back to server local time.
  (`buildConfiguredAgentSystemPrompt` receives `userTimezone`; need to verify the
  plugin-facing path.)
- **Per-session repeat buffer vs. scanning `event.messages`:** which is cheaper and
  more reliable? Likely scan history in v1, add buffer only if needed.
- **Combining secondary modifiers** (late-night + professional) without bloating
  the injected text or hurting cache stability — cap and template carefully.
- **Localisation** of wellbeing phrases and tone guidance for non-English channels.

## 14. Distribution / why not a core PR

OpenClaw's `VISION.md` is explicit: core stays lean, optional capability ships as
plugins ("we welcome PRs and design discussions that extend the plugin API instead
of adding one-off core behavior"), and new skills/capabilities belong on **ClawHub**
rather than core. A tone feature is exactly "optional capability." So:

- **Don't** open a core PR that edits `attempt.ts` / `system-prompt.ts`.
- **Do** publish `openclaw-adaptive-tone` as its own MIT repo; users install it as
  a plugin. Optionally list on ClawHub.
- This needs no maintainer approval to be usable by others — which is the original
  goal ("an update everyone could use"), achieved the way OpenClaw is designed for.

---

### Source references (for implementers)
- Hook firing site: `src/agents/pi-embedded-runner/run/attempt.ts:3563`
- Hook contract: `src/plugins/hook-before-agent-start.types.ts:21-42`
- Handler map: `src/plugins/hook-types.ts` (`before_prompt_build`)
- Base prompt builder: `src/agents/pi-embedded-runner/system-prompt.ts:18`
- Example plugin entry: `extensions/active-memory/index.ts:2909`
- Example manifest: `extensions/active-memory/openclaw.plugin.json`
