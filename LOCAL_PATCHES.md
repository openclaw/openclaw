# Local patches (not upstream)

This checkout runs a **locally patched** OpenClaw build. These commits are intentionally _not_ upstreamed (at least for now), so we need a durable “why” + “where” record.

Branch convention: `local/<upstream-version>` (currently `local/2026.2.9`).

Quick status:

- Upstream base: `v2026.2.9`
- Local head: run `git describe --tags --always`

## Patch list

### 1) WhatsApp: mark outbound messages as disappearing (7d via config)

- Commit: `341653a71` — `feat(whatsapp): support disappearing outbound messages`
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

- Commit: `cfa0bb0fe` — `Browser: avoid screenshot hangs on Linux`
- Why:
  - Prevents sporadic hangs when taking screenshots on Linux in the browser toolchain.
- Notes:
  - Keep local unless/until confirmed safe upstream.

### 3) Cron: don’t skip due jobs when reloading store on timer ticks

- Commit: `de3652cab` — `fix(cron): don't skip due jobs on timer reload`
- Why:
  - A production issue was observed: a cron job scheduled for **02:30 Europe/Rome** did not run, yet `nextRunAtMs` advanced to the next day and no run history was recorded.
  - Root cause: on timer ticks the service reloads the store and recomputed `nextRunAtMs` from “now”, which can jump to the next occurrence and effectively **skip** runs that are already due.
- What:
  - Preserve persisted `job.state.nextRunAtMs` during store reload; only fill it if missing/invalid.
  - Add regression tests.
  - Treat exact boundaries as due (Croner edge case).

### 4) Browser: allow `browser.snapshot` timeout override (fix misleading 20s timeouts)

- Commit: `322a40b2f` — `fix(browser): honor browser.snapshot timeoutMs`
- Why:
  - We use a “fail fast” browser SOP (e.g. `timeoutMs: 3000` + retry once) so long browser calls don’t stall WhatsApp sessions.
  - Previously, `browser.snapshot` ignored tool `timeoutMs` and always used a hard-coded **20s** client timeout, causing apparent “stalls” and misleading errors.
- What:
  - Thread `timeoutMs` through `browserSnapshot()` and the `browser` tool’s `action="snapshot"` handler.
  - Clamp override to `[1000ms, 120000ms]`.

### 5) Browser: allow `browser.navigate` timeout override (avoid 20s stalls)

- Commit: `bb80857fb` — `fix(browser): honor browser.navigate timeoutMs`
- Why:
  - Same SOP rationale as snapshot: fast failures + one retry beats 20s stalls.
  - Previously, `browser.navigate` ignored tool `timeoutMs` and always used a hard-coded **20s** client timeout.
- What:
  - Thread `timeoutMs` from the browser tool into the browser client.
  - Clamp override to `[1000ms, 120000ms]`.

### 6) Browser: allow `browser.screenshot` + `browser.act` timeout override

- Commit: `aa6de86d6` — `fix(browser): honor browser.screenshot and browser.act timeoutMs`
- Why:
  - `browser.screenshot` and `browser.act` previously ignored tool `timeoutMs` and always used a hard-coded **20s** client timeout.
  - In WhatsApp sessions this looks like the browser is “down” when in reality the request just exceeded the client-side 20s.
- What:
  - Thread tool `timeoutMs` through `action="screenshot"` and `action="act"`.
  - Apply timeout to the browser client fetch (clamped to `[1000ms, 120000ms]`).
  - For `act`, also inject `timeoutMs` into the request body when not already present so the server-side Playwright actions respect it.

### 7) Memory/QMD: enforce per-agent QMD isolation for both memory manager and `exec qmd ...`

- Commit: `f986f05e1` — `fix(memory): isolate qmd config/cache per agent in memory and exec`
- Why:
  - We need strict memory boundaries:
    - terminal shell qmd index = obsidian-only
    - main agent qmd = memory/life/tacit only
    - boxed agent qmd = no collections
  - Before this patch, `qmd status` invoked via agent `exec` could still resolve to host-level defaults (`~/.cache/qmd`, `~/.config/qmd`), which looked like leakage even when memory manager isolation was configured.
- What:
  - `src/memory/qmd-manager.ts`
    - set `QMD_CONFIG_DIR=<agent-state>/qmd/xdg-config/qmd` when spawning qmd so collection config is always agent-local.
  - `src/agents/bash-tools.exec.ts`
    - detect `qmd ...` commands and inject agent-scoped env defaults (unless explicitly overridden via `params.env`):
      - `QMD_CONFIG_DIR`
      - `XDG_CONFIG_HOME`
      - `XDG_CACHE_HOME`
    - ensures agent-run `qmd status` reports the agent’s own index/config, not terminal host defaults.

## Operating rules

- Treat this file as the **source of truth** for why a local commit exists.
- When upgrading upstream:
  1. rebase/cherry-pick local patches,
  2. re-validate key behaviors (WhatsApp ephemeral marking; cron jobs actually run; browser SOP timeouts actually honored),
  3. update commit hashes here.
