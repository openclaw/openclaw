# Local patches (not upstream)

This checkout runs a **locally patched** OpenClaw build. These commits are intentionally _not_ upstreamed (at least for now), so we need a durable “why” + “where” record.

Branch convention: `local/<upstream-version>` (currently `local/2026.2.12`).

Quick status:

- Upstream base: `v2026.2.12`
- Local head: run `git describe --tags --always`

## Patch list

### 1) WhatsApp: mark outbound messages as disappearing (7d via config)

- Commit: `e1cb3c55c` — `feat(whatsapp): support disappearing outbound messages`
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
  - `docs/channels/whatsapp.md`

### 2) Browser (Linux): avoid screenshot hangs

- Commit: `8d8ebfe09` — `Browser: avoid screenshot hangs on Linux`
- Why:
  - Prevents sporadic hangs when taking screenshots on Linux in the browser toolchain.
- Notes:
  - Keep local unless/until confirmed safe upstream.

### 3) Cron due-run reload skip fix — dropped (covered upstream)

- Local commit dropped during rebase to `v2026.2.12`.
- Reason:
  - Upstream now includes broader cron scheduling/delivery reliability fixes, and our old local patch no longer applies cleanly.
- Action:
  - Keep as an upstream-owned fix going forward (no local carry patch).

### 4) Browser: allow `browser.snapshot` timeout override (fix misleading 20s timeouts)

- Commit: `a86087bb4` — `fix(browser): honor browser.snapshot timeoutMs`
- Why:
  - We use a “fail fast” browser SOP (e.g. `timeoutMs: 3000` + retry once) so long browser calls don’t stall WhatsApp sessions.
  - Previously, `browser.snapshot` ignored tool `timeoutMs` and always used a hard-coded **20s** client timeout, causing apparent “stalls” and misleading errors.
- What:
  - Thread `timeoutMs` through `browserSnapshot()` and the `browser` tool’s `action="snapshot"` handler.
  - Clamp override to `[1000ms, 120000ms]`.

### 5) Browser: allow `browser.navigate` timeout override (avoid 20s stalls)

- Commit: `c0f87d834` — `fix(browser): honor browser.navigate timeoutMs`
- Why:
  - Same SOP rationale as snapshot: fast failures + one retry beats 20s stalls.
  - Previously, `browser.navigate` ignored tool `timeoutMs` and always used a hard-coded **20s** client timeout.
- What:
  - Thread `timeoutMs` from the browser tool into the browser client.
  - Clamp override to `[1000ms, 120000ms]`.

### 6) Browser: allow `browser.screenshot` + `browser.act` timeout override

- Commit: `cad5573b3` — `fix(browser): honor browser.screenshot and browser.act timeoutMs`
- Why:
  - `browser.screenshot` and `browser.act` previously ignored tool `timeoutMs` and always used a hard-coded **20s** client timeout.
  - In WhatsApp sessions this looks like the browser is “down” when in reality the request just exceeded the client-side 20s.
- What:
  - Thread tool `timeoutMs` through `action="screenshot"` and `action="act"`.
  - Apply timeout to the browser client fetch (clamped to `[1000ms, 120000ms]`).
  - For `act`, also inject `timeoutMs` into the request body when not already present so the server-side Playwright actions respect it.

### 7) Memory/QMD: enforce per-agent QMD isolation for both memory manager and `exec qmd ...`

- Commit: `842ab6def` — `fix(memory): isolate qmd config/cache per agent in memory and exec`
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

### 8) Discord native skill commands: scope to channel-bound agents (avoid `_2` duplicates)

- Commit: `3c155a9f5` — `fix(discord): scope native skill commands to bound agents`
- Why:
  - Discord slash skill commands were built from **all agents**, not just agents routed for Discord.
  - In multi-agent setups this produced duplicate names with numeric suffixes (e.g., `askpi`, `askpi_2`).
- What:
  - Add `listBoundAgentIds(...)` in `src/routing/bindings.ts` to resolve channel/account-scoped agent IDs using binding semantics.
  - Update Discord provider command registration (`src/discord/monitor/provider.ts`) to pass those agent IDs into `listSkillCommandsForAgents(...)`.
  - Add regression tests in `src/routing/bindings.test.ts`.

### 9) Cron delivery: add `delivery.format` (`summary`|`full`) and use `full` for morning rollup

- Commit: `d7d5d1cfd` — `feat(cron): support full delivery format for isolated announce jobs`
- Why:
  - Some jobs (notably `morning-rollup`) must deliver full/untrimmed output.
  - Existing announce flow always rewrote isolated output into a 1–2 sentence summary via `subagent-announce`, overriding skill/user intent.
- What:
  - Add `delivery.format?: "summary" | "full"` across cron types/normalization/gateway schema.
  - Keep default behavior as `summary` when omitted.
  - In isolated runner:
    - `summary` keeps existing shared announce rewrite behavior.
    - `full` bypasses shared announce rewrite for text and delivers payload directly via outbound adapters.
  - Add regression tests for plan/normalization and isolated full-delivery behavior.

### 10) Logging: prevent `/tmp/openclaw` quota blowups from oversized daily log files

- Commit: `working tree (2026-02-20)` — pending commit
- Why:
  - Daily gateway log files under `/tmp/openclaw/openclaw-YYYY-MM-DD.log` grew to multi-GB in less than a day.
  - This triggered write quota errors (`Unknown system error -122`, `Disk quota exceeded`) and caused plugin load failures during startup.
- What:
  - `src/logging/logger.ts`
    - add hard per-file cap (`MAX_LOG_FILE_BYTES = 20 MiB`).
    - enforce cap before appending log lines (truncate when at/above cap).
  - Runtime config hardening (host config, not repo code):
    - set `logging.level = "warn"` in `~/.openclaw/openclaw.json` to reduce high-volume info logging.
  - Operations:
    - truncate oversized `/tmp/openclaw/openclaw-2026-02-18.log` and `/tmp/openclaw/openclaw-2026-02-19.log`.
    - restart gateway after freeing `/tmp`.

### 11) Browser control errors: stop mislabeling stale tab/element failures as service outages

- Commit: `working tree (2026-02-20)` — pending commit
- Why:
  - Browser tool failures like `tab not found` or `Element "... not found or not visible"` were being presented as “Can’t reach the OpenClaw browser control service,” which is misleading and pushes the wrong remediation (restart) instead of a fresh snapshot/tab selection.
- What:
  - `src/browser/client-fetch.ts`
    - preserve HTTP/application errors as `BrowserControlHttpError` and only apply the “service unreachable” wrapper for real transport/timeout failures.
  - `src/agents/tools/browser-tool.ts`
    - for `act` errors that look like stale element refs, throw explicit guidance to run a new `snapshot` on the same tab and retry with fresh refs.

### 12) Auth profile cooldown reasoning: stop labeling timeouts as `rate_limit`

- Commit: `working tree (2026-02-20)` — pending commit
- Why:
  - Provider/profile cooldown incidents triggered by long-running turns were being surfaced as `rate_limit` even when no 429 occurred.
  - This caused misleading operator messaging (`Provider ... in cooldown (rate_limit)`), making timeout debugging harder.
- What:
  - `src/agents/auth-profiles/types.ts`
    - add `lastFailureReason?: AuthProfileFailureReason` to profile usage stats.
  - `src/agents/auth-profiles/usage.ts`
    - add timeout-specific cooldown helper (`calculateAuthProfileTimeoutCooldownMs`).
    - persist `lastFailureReason` on failures.
    - clear `lastFailureReason` on successful use / cooldown clear paths.
  - `src/agents/pi-embedded-runner/run.ts`
    - derive failover reason from latest profile failure reason instead of hard-coding `rate_limit` when profiles are in cooldown.
    - update timeout log text to remove misleading “possible rate limit” wording.
  - `src/agents/model-fallback.ts`
    - map provider-cooldown failover reason from profile stats (when available) instead of forcing `rate_limit`.

### 13) Summarize turns: per-request no-timeout override without changing global defaults

- Commit: `working tree (2026-02-20)` — pending commit
- Why:
  - Summarize jobs can run longer than normal agent turns.
  - Increasing global `agents.defaults.timeoutSeconds` is too broad and weakens timeout behavior for unrelated sessions.
- What:
  - `src/auto-reply/reply/dispatch-from-config.ts`
    - detect summarize-like inbound turns (summarize intent + URL).
  - set `timeoutOverrideSeconds: 0` for those turns only (unless a timeout override is already explicitly provided upstream).
  - keep default timeout behavior unchanged for all non-summarize traffic.
  - This uses the existing reply pipeline override (`GetReplyOptions.timeoutOverrideSeconds`) rather than config-level timeout inflation.

### 14) Gateway pressure hardening: cgroup cleanup + health burst damping + remote probe backoff

- Commit: `working tree (2026-02-20)` — pending commit
- Why:
  - Browser/control failures were correlated with restart leftovers in the gateway cgroup, health request bursts, and repeated remote-skill probe failures without backoff.
  - Needed explicit hardening so pressure does not rebuild across restarts.
- What:
  - Service unit defaults (`src/daemon/systemd-unit.ts`):
    - switch to `KillMode=mixed` with `TimeoutStopSec=15` and `SendSIGKILL=yes`.
  - Startup self-heal (`src/gateway/startup-cgroup-gc.ts`, wired in `src/gateway/server.impl.ts`):
    - Linux-only cgroup scan at startup.
    - terminate + force-kill non-descendant stale members from the gateway cgroup.
  - Browser crashpad GC (`src/browser/crashpad-gc.ts`, wired in `src/browser/chrome.ts`):
    - Linux-only stale crashpad cleanup scoped to OpenClaw-managed `user-data-dir`.
    - run pre-launch and on stop/launch-failure.
    - only reap when no matching profile Chromium process is active (avoids touching live sessions).
  - Health burst damping:
    - `src/gateway/server-methods/health.ts`: coalesce/throttle cached-path background refreshes.
    - `src/gateway/server/ws-connection/message-handler.ts`: per-connection non-probe health throttle using cached snapshot.
    - new knobs in `src/gateway/server-constants.ts` for testability.
  - Remote skills probe resilience (`src/infra/skills-remote.ts`):
    - exponential backoff + temporary circuit breaker on repeated failures.
    - clear probe state on successful refresh / node removal.
  - Tests:
    - `src/gateway/startup-cgroup-gc.test.ts`
    - `src/gateway/server-methods/health.test.ts`
    - `src/gateway/server/ws-connection/health-pressure.test.ts`
    - `src/infra/skills-remote.backoff.test.ts`
  - `src/daemon/systemd.test.ts` (unit rendering assertions)

### 15) Browser profiles: per-profile headless/headful mode selection

- Commit: `working tree (2026-02-20)` — pending commit
- Why:
  - Browser launch mode was globally controlled by `browser.headless`, so the agent could not choose headful vs headless by profile.
  - We need profile-level mode control (for example, `openclaw` headful and `work` headless) while keeping a global fallback.
- What:
  - Add `browser.profiles.<name>.headless?: boolean` in config types + schema.
  - Resolve effective mode per profile in `resolveProfile`:
    - use profile override when set
    - otherwise fallback to global `browser.headless`
  - Use resolved profile mode in Chrome launch args:
    - `--headless=new`/`--disable-gpu` now keyed to the selected profile.
    - Linux headful X11/Ozone fallback now keyed to the selected profile.
  - Status endpoint now reports the selected profile’s effective `headless` mode.
  - Add focused tests for config precedence and launch-arg behavior.
  - Update browser docs and configuration reference with per-profile examples.

### 16) Gateway startup cgroup cleanup: keep orphan reaping, stop killing SSH/session siblings

- Commit: `working tree (2026-02-20)` — pending commit
- Why:
  - The initial startup cgroup cleanup could terminate non-descendant processes in the current cgroup too aggressively.
  - In SSH/manual runs this could kill the active SSH session; in systemd starts it could kill same-start invocation siblings (notably `ExecStartPost`), causing flapping (`control process exited, status=15/TERM`).
  - We still want stale orphan cleanup to work for previous failed runs.
- What:
  - `src/gateway/startup-cgroup-gc.ts`
    - keep cleanup enabled under systemd (`OPENCLAW_SYSTEMD_UNIT`) and explicit env override (`OPENCLAW_ENABLE_STARTUP_CGROUP_GC`).
    - skip cleanup outside service cgroups.
    - skip descendants/ancestors of the current gateway process.
    - skip processes with the same `INVOCATION_ID` as the current systemd start (protects `ExecStartPost` siblings in the same start attempt).
    - only reap older non-descendant PIDs (startup-time ordering guard).
  - `src/gateway/startup-cgroup-gc.test.ts`
    - add regression coverage for non-service cgroup skip and same-invocation sibling protection while still reaping eligible stale members.

## Operating rules

- Treat this file as the **source of truth** for why a local commit exists.
- When upgrading upstream:
  1. rebase/cherry-pick local patches,
  2. re-validate key behaviors (WhatsApp ephemeral marking; cron jobs actually run; browser SOP timeouts actually honored),
  3. update commit hashes here.
