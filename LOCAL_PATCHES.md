# Local patches (not upstream)

This checkout runs a **locally patched** OpenClaw build. These commits are intentionally _not_ upstreamed (at least for now), so we need a durable “why” + “where” record.

Branch convention: `local/<upstream-version>` (currently `local/2026.2.6`).

Quick status:

- Upstream base: `v2026.2.6`
- Local head: run `git describe --tags --always`

## Patch list

### 1) WhatsApp: mark outbound messages as disappearing (7d via config)

- Commit: `1cc973c2a` — `feat(whatsapp): support disappearing outbound messages`
- Why:
  - We want **only outbound messages** to be sent as ephemeral (disappearing) without toggling a chat’s disappearing setting (to avoid WhatsApp system notices like “disappearing messages turned on”).
  - Enforces 7-day expiry via config (`604800` seconds).
- What:
  - Adds config:
    - `channels.whatsapp.disappearingMessagesSeconds`
    - `channels.whatsapp.accounts.<id>.disappearingMessagesSeconds`
  - Plumbs Baileys `ephemeralExpiration` into all outbound send paths (reply/sendMedia/web send API/polls).
  - Falls back to WhatsApp creds default disappearing mode if config is unset.
- Files / docs touched:
  - `src/web/...`, `src/config/...`
  - `docs/channels/whatsapp.md`, `docs/gateway/configuration.md`
  - `src/config/schema.ts`

### 2) Browser (Linux): avoid screenshot hangs

- Commit: `6f8c5c162` — `Browser: avoid screenshot hangs on Linux`
- Why:
  - Prevents sporadic hangs when taking screenshots on Linux in the browser toolchain.
- Notes:
  - Keep local unless/until confirmed safe upstream.

### 3) Browser: allow `browser.snapshot` timeout override (fix misleading 20s timeouts)

- Commit: `623234c70` — `fix(browser): honor browser.snapshot timeoutMs`
- Why:
  - Subagents (and the main agent) sometimes hit intermittent `browser.snapshot` failures on heavy pages (e.g. Google Maps) with:
    - `Can't reach the OpenClaw browser control service (timed out after 20000ms)`
  - This is often **not** a gateway outage; it’s the snapshot operation exceeding a **hard-coded 20s client timeout**.
  - The browser tool schema already accepted `timeoutMs`, but the snapshot path ignored it, so agents would set `timeoutMs: 60000` and still fail at 20s.
- What:
  - Thread `timeoutMs` through `browserSnapshot()` and the `browser` tool’s `action="snapshot"` handler.
  - Cap override to 120s.

### 4) Cron: don’t skip due jobs when reloading store on timer ticks

- Commit: `bb7123a0f` — `fix(cron): don't skip due jobs on timer reload`
- Why:
  - A production issue was observed: a cron job scheduled for **02:30 Europe/Rome** did not run, yet `nextRunAtMs` advanced to the next day and no run history was recorded.
  - Root cause: on timer ticks the service reloads the store and recomputed `nextRunAtMs` from “now”, which can jump to the next occurrence and effectively **skip** runs that are already due.
- What:
  - Preserve persisted `job.state.nextRunAtMs` during store reload; only fill it if missing/invalid.
  - Add regression tests.
  - Adjust cron next-run computation to treat exact boundaries as due.

## Operating rules

- Treat this file as the **source of truth** for why a local commit exists.
- When upgrading upstream:
  1. rebase/cherry-pick local patches,
  2. re-validate key behaviors (WhatsApp ephemeral marking; cron jobs actually run at boundary times),
  3. update `Local describe:` + commit hashes here.
