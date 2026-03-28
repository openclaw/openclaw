---
name: football_live_commentary
description: "Live football commentary helper: Opta-style events (opta-live-pack.mjs) or Nami 纳米直播事件 (nami-live-pack.mjs, doc https://www.nami.com/zh/details/j3ry6iztqltnwe0). Outputs commentaryPack with priority filtering, match context, persona guides. Nami needs NAMI_USER+NAMI_SECRET; optional NAMI_PATH_LIVE_EVENTS fetch. Do not paste raw firehoses into the model. Compliance: no illegal betting encouragement."
metadata: { "openclaw": { "emoji": "🎙️", "requires": { "bins": ["node"] } } }
---

# Football live commentary (Opta- or Nami-shaped events)

Opta / Stats Perform and **纳米数据「足球实时数据」** expose **fine-grained atomic events**. Sending them **directly** to the model wastes tokens and produces **fragmented** commentary.

This skill uses:

- **`scripts/opta-live-pack.mjs`** — generic JSON/NDJSON (Opta-like field names).
- **`scripts/nami-live-pack.mjs`** — **Nami** live feeds: normalize vendor fields, then the **same** `commentaryPack` pipeline. Product page: [纳米 · 足球实时数据 API](https://www.nami.com/zh/details/j3ry6iztqltnwe0). Auth: **`NAMI_USER`** + **`NAMI_SECRET`** (query params); **IP allowlist** may apply per contract. Override **`NAMI_PATH_LIVE_EVENTS`**, **`NAMI_PARAM_LIVE_MATCH_ID`**, **`NAMI_LIVE_EXTRA`** (JSON) to match your documentation. Default fetch path is a placeholder (`/api/v5/football/match/live`) — **confirm against your contract**.

Both output a **`commentaryPack`**: filtered cues, **match context**, and **persona** instructions — **not** a wall of raw events.

## Four design pillars (agent behavior)

### 1. Importance tiers (event filtering)

- **High — speak immediately**  
  Goals, cards (yellow/red / second yellow), **penalty** outcomes, **substitutions**, **VAR** / review signals. These map to `commentaryPack.immediate` with `requiresInstantNarration: true`.

- **Medium — batch then summarize**  
  Shots on target / woodwork / big saves, **long pass chains** (default **15+** consecutive passes same team, configurable), **danger-area** fouls / clearances when qualifiers suggest the box. These are folded into **`deferredWindows`** (do not read row-by-row on air).

- **Low — default skip**  
  Routine passes, throw-ins, generic duels. Counted in `suppressedLowPriorityCount`. Only if a **burst** of many low-priority events happens in a short **match-time window** does the pack emit one **low_priority_burst** deferred window — one sentence on “tempo / scrappy phase”, not per event.

### 2. Match context (memory)

`commentaryPack.matchContext` includes:

- **score** and **scoreLine** (update from **Goal**-style events when team side is known).
- **phase**: `opening`, `second_half_opening`, `late_game`, `stoppage_or_extra`, etc.
- **narrativeToneHint** (leading / level / chasing).
- **timeSensitivityNote** (e.g. opening vs stoppage — same foul, different **emotional intensity** guidance).

The model should **blend** this with the live minute when speaking.

### 3. Persona (style)

`--persona` selects a **guide string** in `personaGuide` + `modelInstructions` (not a full script — the model still writes the lines):

| CLI                                         | Persona                                                          |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `neutral`                                   | Balanced, factual.                                               |
| `data` (alias `zhanjun`)                    | Data-forward, concise, name key players.                         |
| `passion` (alias `huang`, `huangjianxiang`) | High energy on **high** events only; no forced hype on low tier. |
| `poetic` (alias `hewei`)                    | Measured imagery on key moments; avoid cliché stacks.            |

### 4. Token discipline

- **Never** paste full `events` arrays into the user chat.
- Pass **`commentaryPack`** (and at most **one** short sample of raw events when debugging).
- Prefer **`modelInstructions`** + **`immediate`** + **`deferredWindows`** for the next utterance.

## Input format (flexible JSON)

Each event should be one object (JSON array file, or **NDJSON** on stdin). Recognized fields (best-effort):

- Time: `minute`, `second`, or nested `time` / `clock`.
- Type: `type` (string or `{ name }`), `eventType`, `typeName`, `qualifiers[]`, `outcome`.
- Side: `isHome`, `teamId`, `contestantId`, `team`, or pass `--home-id` / `--away-id` for stable IDs.

Vendor-specific shapes vary; substring matching on the normalized type string is intentional.

## Commands

```bash
node skills/football-live-commentary/scripts/opta-live-pack.mjs \
  --file skills/football-live-commentary/scripts/examples/sample-opta-events.json \
  --persona data \
  --home-name "Red FC" \
  --away-name "Blue United"

# NDJSON pipe
cat events.ndjson | node skills/football-live-commentary/scripts/opta-live-pack.mjs --stdin --persona hewei

# Nami (纳米) — from file or NDJSON (same flags as opta-live-pack)
node skills/football-live-commentary/scripts/nami-live-pack.mjs \
  --file skills/football-live-commentary/scripts/examples/sample-nami-events.json \
  --persona data \
  --home-name "主队" \
  --away-name "客队"

# Nami — fetch from gateway (paths/params per contract)
export NAMI_USER="your_user"
export NAMI_SECRET="your_secret"
node skills/football-live-commentary/scripts/nami-live-pack.mjs \
  --fetch --match-id 12345678 \
  --persona neutral
```

## Output keys (for the model)

- **`immediate`** — high-priority cues with clock tags.
- **`deferredWindows`** — merged medium/burst batches.
- **`matchContext`** — score, phase, tone hints.
- **`personaGuide`** / **`modelInstructions`** — how to sound for this run.
- **`suppressedLowPriorityCount`** — how much noise was dropped.

## Compliance

- **Gambling**: do not encourage illegal betting; live commentary is **sports description**, not wagering advice.
- **Accuracy**: event classification is **heuristic**; when unsure, say so and avoid inventing facts.

## Relation to `football-match-analyst`

- **match-analyst** = pre-match **aggregate** `llmPack` from APIs.
- **live-commentary** = **in-match** event stream → **commentaryPack**.  
  Both can use Opta/Stats Perform or **纳米** contracts; **do not** confuse pre-match stats with live event payloads.

## Nami env reference (live commentary)

| Variable                    | Purpose                                            |
| --------------------------- | -------------------------------------------------- |
| `NAMI_USER` / `NAMI_SECRET` | Required for `--fetch`.                            |
| `NAMI_API_BASE`             | Gateway (default `https://open.sportnanoapi.com`). |
| `NAMI_PATH_LIVE_EVENTS`     | HTTP path for live event list (contract-specific). |
| `NAMI_PARAM_LIVE_MATCH_ID`  | Query key for match id (default `match_id`).       |
| `NAMI_LIVE_MATCH_ID`        | Optional default id when not passing `--match-id`. |
| `NAMI_LIVE_EXTRA`           | JSON object merged into the request query string.  |
