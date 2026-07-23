---
name: "bart-transit"
description: "BART schedule lookups, fuzzy station resolution, and ride-back seat strategy."
allowed-tools:
  - exec
---

# BART transit

Use when the user asks for BART trains, station codes, next departures/arrivals, getting home from SF to Union City, or whether to ride backward to get a seat.

## Capabilities

- Resolve station names/codes from fuzzy user text, typos, neighborhood-ish names, or BART abbreviations.
- Fetch next 4-5 BART departure/arrival pairs.
- Compare candidate SF origin stations behind the user's current station to decide whether riding backward 1-4 stops is worth it.
- Format concise chat output suitable for Slack/mobile.
- Keep family pickup sharing separate from lookup; do not send ETAs to other people unless explicitly asked.

## API key

The legacy Kebume/Django implementation required a BART API key from `HTK_BART_API_KEY`. This skill should use `BART_API_KEY` or `HTK_BART_API_KEY` from the environment/config. It is not user OAuth; it is a BART API developer/shared key. Do not print it.

Static station resolution does not need a key. Live schedules do.

## Workflow

1. Parse intent:
   - Station list/code lookup: return matching stations.
   - Basic trip lookup: identify origin, destination, optional date/time, and count.
   - Homeward seat strategy: infer destination `UCTY` unless user says otherwise, current station if supplied, and candidate SF stations behind current station.
2. Resolve stations:
   - Accept exact BART codes case-insensitively.
   - Use station aliases from `references/stations.json`.
   - Use fuzzy matching for names and typo tolerance.
   - If multiple plausible stations remain, ask one short clarifying question.
3. For schedules, prefer the helper script:
   ```bash
   python scripts/bart_schedule.py depart --orig MONT --dest UCTY --count 5
   ```
4. For ride-back strategy:
   - Candidate SF downtown/Mission sequence toward Millbrae/SFO direction: `EMBR`, `MONT`, `POWL`, `CIVC`, `16TH`.
   - Never recommend riding backward more than 4 stops.
   - For each previous station candidate, compare:
     - outbound/backward wait + ride time to candidate station
     - next homeward train arrival at candidate station
     - next homeward train arrival at current station
   - Recommend riding backward only when the expected seat benefit is likely and the time penalty is reasonable.
   - If exact opposite-direction ETD data is unavailable, explain the assumption and give the raw schedule table instead of overclaiming.
5. Format output:
   - Show 4-5 rows by default: `depart → arrive (duration)`.
   - Include station names and codes once at the top.
   - For strategy, include a one-line recommendation plus supporting times.

## Safety and privacy

- BART lookup is fine to answer directly.
- Do not send pickup ETA to family/third parties unless the user explicitly asks in the current turn.
- Do not expose API keys or old Django settings values.

## Legacy reference

Old implementation lived on zion under `/home/jontsai/sites/kebu.me/www`:

- `htk/lib/sfbart/utils.py:get_bart_schedule_depart`
- `htk/lib/sfbart/api.py:BartAPI.get_schedule_depart`
- `htk/lib/sfbart/constants.py:BART_STATION_ABBREVIATIONS`
- `htk/lib/slack/event_handlers.py:def bart`
- `kebume/slackbot/event_handlers.py:go` for Jon's old `go home` flow

The legacy flow required exact station abbreviations; this skill should improve on that with fuzzy/LLM-assisted station resolution.
