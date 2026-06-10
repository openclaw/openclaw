# Channel Error Hardening — Anti-Hammering Plan

> **Status:** DELIVERED 2026-06-10 (B1 dropped — see addendum) · **Created:** 2026-06-10 · **Author:** agentglob ops
>
> **Context:** recurring incidents where a terminal API error (Telegram 401,
> model discovery timeout) causes a gateway to retry indefinitely, burning CPU,
> filling logs, and pressuring host swap — without any human-visible alert.
> Observed agents: mikyhelper (deleted), productguy (OB-8), cashtronics,
> researcher, JoJo PM (OB-12). The class recurs because no gateway-level
> circuit breaker or infra-level restart cap exists today.

---

## Phase A — Circuit breaker in the gateway (root fix)

**Repo:** `cryptolir/openclaw` · needs a gateway image build + fleet rolling deploy.

1. **Error classification.** Extend (or add beside) `src/telegram/api-logging.ts`
   `withTelegramApiErrorLogging` to split errors into two buckets:
   - **Terminal** — 401 Unauthorized, 403 Forbidden, "bot not found" (will never
     succeed without human action). Stop retrying; mark channel disabled.
   - **Transient** — network errors, 429 rate-limit, Telegram 5xx. Worth retrying
     with backoff (see below).

2. **Boot probe.** On channel start, call `getMe` once before registering commands
   or starting polling. A terminal response → skip channel startup entirely and
   emit one loud log line (not per-retry spam).

3. **Circuit breaker.** On any terminal error in-flight:
   - Open the circuit: stop all Telegram API traffic for that bot.
   - Re-probe `getMe` **once per hour**.
   - If the token has been fixed (docker.env updated + container restarted), the
     probe succeeds → close circuit, resume normally.
   - Never touches other channels (web chat, cron, etc.) — the agent stays alive.

4. **Transient error backoff.** Exponential with jitter, capped at ~5 minutes.
   Replaces the current immediate-retry behaviour in the polling loop.

5. **Observability.** Circuit state (open/closed) surfaced in the gateway health
   endpoint and in the dashboard agent health view. One log line per state change,
   not one per failed attempt.

---

## Phase B — Infra containment via compose (quick win, no release needed)

**Repo:** `cryptolir/openclaw-dashboard` (compose template) +
`cryptolir/openclaw/scripts/ops/` (watchdog cron).

1. **Restart policy.** Change the shared compose from `restart: always` /
   `unless-stopped` to `on-failure` with a retry cap (e.g. `max_attempts: 5`).
   Docker backs off between restarts — that's the "kill after a few minutes" part.

2. **Hourly watchdog cron.** A lightweight script on each host (same pattern as
   `diagnostic-cron.sh`) that finds exited gateway containers and does `docker
   compose up -d`. That's the "try again after an hour" part.
   - Smart touch: if the last N lines of the container's logs match known terminal
     signatures (401 loop, EPIPE on boot), skip the revival and instead write an
     entry to `bug_list.md` AUTOSCAN — let the human decide.

3. **Per-container resource limits.** Add `mem_limit` + `cpus` to the compose
   template so a looping agent can't drag the host into swap. Directly addresses
   the 1478 MiB swap pressure (OB-9 / autoscan 2026-06-10).

**Why do this even when Phase A is planned:** Phase B caps blast radius for *every
future bug class*, not just Telegram. It protects the host regardless of whether
the loop is in a channel adapter, a model retry, or code not yet written.

---

## Phase C — Validate before deploy (prevention)

**Repo:** `cryptolir/openclaw-dashboard` — dashboard deploy/create-agent flow.

When an agent is created or reconfigured with a Telegram bot token:
- Call `getMe` once during the deploy/provision step.
- If 401 → fail the deploy with a clear user-facing error. Never write an invalid
  token to `docker.env` and start a container that will loop.

This would have caught both mikyhelper and productguy before they were ever deployed.

---

## Phase D — Faster detection

**Repo:** `cryptolir/openclaw/scripts/ops/agents_server_diagnostic.sh`

The daily autoscan already detects 401 signatures and flags them in `bug_list.md`.
Additions:
- **Restart-count delta between scans** — flag agents whose `RestartCount` increased
  by more than N since yesterday, even if the error signature is new/unknown.
- **Log-write-rate check** — containers writing logs at >1 MB/min between scans are
  likely in a tight loop; flag for investigation.

---

## Suggested delivery order

| Phase | Effort | Blocks release? | Rationale |
|-------|--------|-----------------|-----------|
| B     | Small  | No              | Caps blast radius today; survives any future bug |
| C     | Small  | No              | Stops new occurrences at the source |
| A     | Medium | Yes (gateway)   | Root fix; fold into next scheduled gateway release |
| D     | Small  | No              | Faster signal; fold into next diagnostic cron update |

---

## Related

- `scripts/ops/bug_list.md` — OB-1, OB-8, OB-9, OB-10, OB-12
- `docs/ops/INFRASTRUCTURE.md` — deploy protocol, host map
- `scripts/ops/diagnostic-cron.sh` — daily health scan
- `src/telegram/api-logging.ts` — current error wrapper (Phase A touch point)
- `src/telegram/bot-native-command-menu.ts` — `setMyCommands` call site

---

## Addendum — review corrections & delivery record (2026-06-10)

The plan shipped same-day in the reviewed order **C → B2/B3 → A → D**, with these
corrections to the original text:

1. **Premise correction.** "No gateway-level circuit breaker or restart cap
   exists" was wrong: `server-channels.ts` already had exponential backoff
   (5-min cap) and a 10-attempt give-up. The actual infinite loop was
   `channel-health-monitor.ts` reviving the given-up channel 3×/hour forever.
   Phase A therefore became a much smaller diff: terminal/transient
   classification + a sticky 60-min pause the monitor respects (expiry = the
   hourly re-probe; explicit channel start clears it immediately).
2. **B1 dropped** (`restart: on-failure` + max_attempts). Containers with
   `on-failure` don't auto-start after a host reboot (fleet-wide outage
   risk), and none of the motivating incidents would have been caught — those
   containers never exited; the loops were in-process. `unless-stopped` stays.
3. **Repo correction.** The shared compose template lives in `cryptolir/openclaw`
   (`docker-compose.yml`, checked out at `/opt/openclaw`), not the dashboard.
4. **Single-writer rule.** The watchdog records to
   `/root/.openclaw/watchdog-state.json`; only the daily diagnostic writes
   `bug_list.md` (it folds the watchdog's last 24 h in).
5. **Limits are measured, not guessed.** 2026-06-10 fleet measurement: steady
   248–440 MiB, boot ~620 MiB → `mem_limit: 1g`, `cpus: 1.0`.

Delivered:

| Phase | What shipped | Where |
|-------|--------------|-------|
| C | `getMe` probe blocks persisting terminally-invalid bot tokens (network failure = warn-and-save) | openclaw-dashboard#115 |
| B2 | `gateway-watchdog.sh` hourly cron on both hosts: revives non-zero exits (max 3/run, 20 s stagger), skips terminal signatures, records to state file | `scripts/ops/gateway-watchdog.sh`, commit `abc1c6c5cd` |
| B3 | `mem_limit: 1g` + `cpus: 1.0` per gateway in the shared compose | `docker-compose.yml`, commit `abc1c6c5cd` |
| A | Terminal-error circuit in the gateway (pause + hourly re-probe + `terminalError` in snapshot) | openclaw#58 |
| D | Diagnostic: restart-delta keyed on container ID, >5 MB/h log-rate flag, watchdog-state folding, terminal-pause signature | `agents_server_diagnostic.sh` (this commit) |

Phase A's image release also unifies the US image drift (designer/agentav/gems
were on stale local `v2026.05.05.1`) and recreates EU containers, closing OB-6
(log rotation) — see `scripts/ops/bug_list.md`.
