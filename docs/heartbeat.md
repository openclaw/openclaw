---
summary: "Plan for heartbeat polling messages and notification rules"
read_when:
  - Adjusting heartbeat cadence or messaging
---
# Heartbeat polling plan (2025-11-26)

Goal: add a simple heartbeat poll for the embedded agent that only notifies users when something matters, using the `HEARTBEAT_OK` sentinel. The heartbeat body we send is `HEARTBEAT` so the model can easily spot it.

## Prompt contract
- Extend the agent system prompt to explain: “If this is a heartbeat poll and nothing needs attention, reply exactly `HEARTBEAT_OK` and nothing else. For any alert, do **not** include `HEARTBEAT_OK`; just return the alert text.” Heartbeat prompt body is `HEARTBEAT`.
- Keep existing WhatsApp length guidance; forbid burying the sentinel inside alerts.

## Config & defaults
- New config key: `agent.heartbeatMinutes` (number of minutes; `0` disables).
- Default: 30 minutes.
- New optional idle override for heartbeats: `session.heartbeatIdleMinutes` (defaults to `idleMinutes`). Heartbeat skips do **not** update the session `updatedAt` so idle expiry still works.

## Poller behavior
- When gateway runs with command-mode auto-reply, start a timer with the resolved heartbeat interval.
- Each tick invokes the configured command with a short heartbeat body (e.g., “(heartbeat) summarize any important changes since last turn”) while reusing the active session args so Pi context stays warm.
- Heartbeats never create a new session implicitly: if there’s no stored session for the target (fallback path), the heartbeat is skipped instead of starting a fresh Pi session.
- Abort timer on SIGINT/abort of the gateway.

## Sentinel handling
- Trim output. If the trimmed text equals `HEARTBEAT_OK` (case-sensitive) -> skip outbound message.
- Otherwise, send the text/media as normal, stripping the sentinel if it somehow appears.
- Treat empty output as `HEARTBEAT_OK` to avoid spurious pings.

## Logging requirements
- Normal mode: single info line per tick, e.g., `heartbeat: ok (skipped)` or `heartbeat: alert sent (32ms)`.
- `--verbose`: log start/end, command argv, duration, and whether it was skipped/sent/error; include session ID and connection/run IDs via `getChildLogger` for correlation.
- On command failure: warn-level one-liner in normal mode; verbose log includes stdout/stderr snippets.

## Failure/backoff
- If a heartbeat command errors, log it and retry on the next scheduled tick (no exponential backoff unless command repeatedly fails; keep it simple for now).

## Tests to add
- Unit: sentinel detection (`HEARTBEAT_OK`, empty output, mixed text), skip vs send decision, default interval resolver (30m, override, disable).
- Unit/integration: verbose logger emits start/end lines; normal logger emits a single line.

## Documentation
- Add a short README snippet under configuration showing `heartbeatMinutes` and the sentinel rule.
- Expose CLI triggers:
  - `clawdis heartbeat` (web provider, defaults to first `routing.allowFrom`; optional `--to` override)
    - `--session-id <uuid>` forces resuming a specific session for that heartbeat
  - `clawdis gateway --heartbeat-now` to run the gateway loop with an immediate heartbeat
  - Gateway supports `--heartbeat-now` to fire once at startup.
  - When multiple sessions are active or `routing.allowFrom` is only `"*"`, require `--to <E.164>` or `--all` for manual heartbeats to avoid ambiguous targets.
