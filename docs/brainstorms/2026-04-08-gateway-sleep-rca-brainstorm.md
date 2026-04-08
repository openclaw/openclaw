# RCA: Gateway "Falls Asleep" — Recurring Service Death

**Date:** 2026-04-08
**Status:** Brainstorm complete, ready for planning
**Severity:** High — gateway goes fully unresponsive for hours

## What We're Solving

OpenClaw's systemd user service (`openclaw-gateway.service`) repeatedly dies and doesn't come back. Despite `Restart=always` in the unit file, the service stays dead for hours until manually restarted. This has happened multiple times across April 3, 7, and 8.

## Root Cause Analysis

### Structural Root Cause

`Restart=always` only covers **unexpected exits** (crashes, OOM kills, non-zero exits). When any process runs `systemctl --user stop openclaw-gateway.service`, systemd records the **desired state** as "inactive" and the `Restart=` policy does not apply. The service stays dead indefinitely.

**There is no external watchdog, timer, or keepalive mechanism** to detect this and restart the service.

### Code Paths That Can Issue `systemctl stop`

| Path                                                  | Command                                        | Restart After?          |
| ----------------------------------------------------- | ---------------------------------------------- | ----------------------- |
| `openclaw gateway stop` / `openclaw daemon stop`      | `systemctl --user stop`                        | No                      |
| `openclaw reset` (`src/commands/reset.ts:41`)         | `service.stop()`                               | No (prints hint only)   |
| `openclaw uninstall` (`src/commands/uninstall.ts:73`) | `service.stop()` + `disable`                   | No (intentional)        |
| `openclaw update` (restart script)                    | `systemctl --user restart` via detached script | Only if script executes |
| `openclaw install` / `onboard --install-daemon`       | `systemctl --user restart` (atomic)            | Yes                     |
| External (Claude Code session, manual SSH)            | `systemctl --user stop`                        | No                      |

### Today's Specific Trigger (Apr 08, 17:02 UTC)

**Timeline:**

- 10:45-11:15 — `openclaw update` runs, creates 3 restart scripts in `/tmp` (all still exist = never executed)
- 12:29-12:35 — AI agent requests multiple gateway restarts via gateway tool (SIGUSR1, all successful)
- 13:22-13:43 — Three `systemctl restart` cycles (Stopped -> Started instantly)
- 13:48 — `openclaw onboard` spawned (PID 3953497 -> child PID 3953508 `openclaw-onboard`)
- 13:52-13:55 — Two SIGUSR1 config reloads (auth profiles, plugins) — triggered by onboard writing config
- 17:02:27 — SIGTERM from systemd -> clean exit 0, NO restart. **Service dead for 3+ hours.**

**Evidence for the trigger:**

- 4 orphaned restart scripts in `/tmp/openclaw-restart-*.sh` — all still exist, meaning they were created but NEVER executed. The update flow's restart mechanism failed silently.
- The `openclaw-onboard` child process (PID 3953508) is stuck in a CPU spin loop at 100% for 6+ hours. It's a pure userspace infinite loop (wchan=0, no I/O, no network, only pipes).
- No auditd installed, D-Bus messages not journaled — cannot definitively trace the `systemctl stop` caller.
- **Most likely scenario**: The update flow (v2026.4.8 -> v2026.4.9) stopped the service but the detached restart script failed to spawn/execute, leaving the service dead.

**Why it keeps recurring:**

1. The structural gap (no watchdog for explicit stops) has never been closed
2. An existing remediation plan (`docs/plans/2026-04-08-001-fix-openclaw-health-audit-remediation-plan.md`) recommends fixes but NONE are implemented
3. Every previous occurrence was fixed by manual restart without addressing the vulnerability
4. The update CLI's restart mechanism is fragile — depends on a detached shell script that can silently fail

### Secondary Issues Found

1. **Stuck onboard process** — PID 3953508 at 100% CPU since 13:48 (6+ hours, 458MB RSS). Pure userspace spin loop. Needs investigation and kill.
2. **Recurring model errors** — `openai-codex/minimax` model_not_found (wrong prefix, should be `openrouter/minimax/minimax-m2.7`)
3. **Context overflow** — Session hit context overflow with minimax model, auto-compaction failed
4. **Orphaned restart scripts** — 4 scripts in `/tmp` from failed update restarts, never cleaned up
5. **3.4GB peak memory** — Gateway consumed 3.4GB before being stopped

## Why This Approach

### Chosen: Systemd Watchdog Timer Unit (Approach A)

A companion `openclaw-gateway-watchdog.timer` + `.service` pair that:

1. Runs every 60 seconds
2. Probes the gateway health endpoint (HTTP on port 18789)
3. If the gateway is dead/unresponsive, runs `systemctl --user start openclaw-gateway.service`

**Why this over alternatives:**

- **Only mechanism that recovers from explicit stops** — `Restart=always` can't do this, `WatchdogSec` can't do this, `RefuseManualStop` prevents stops but doesn't recover from them
- **No gateway code changes** — pure systemd configuration, works with any gateway version
- **Standard pattern** — well-understood systemd idiom for service supervision
- **Minimal blast radius** — `systemctl start` on an already-running service is a no-op

**Also adding: auditd rule** for `systemctl` commands to trace future stop triggers.

### Rejected Alternatives

- **WatchdogSec + RefuseManualStop** — WatchdogSec detects hung processes but can't recover from explicit stops. RefuseManualStop interferes with legitimate update/uninstall flows.
- **Cron band-aid** — Less integrated than systemd timer, harder to manage lifecycle, doesn't benefit from systemd dependency tracking.
- **In-process keepalive** — The gateway can't watch itself if it's dead.

## Key Decisions

1. **Watchdog timer interval: 60 seconds** — balances recovery speed with overhead
2. **Health check method: HTTP probe** on `http://localhost:18789/health` (or `systemctl --user is-active`)
3. **Recovery action: `systemctl --user start`** (not restart — start is a no-op if already running)
4. **Install auditd** with a rule for `systemctl` calls by UID 1003 to trace future triggers
5. **Kill the stuck onboard process** after documenting its state
6. **Clean orphaned restart scripts** from `/tmp`

## Open Questions

None — all questions resolved during brainstorm.

## Immediate Actions (Pre-Planning)

1. Kill stuck `openclaw-onboard` (PID 3953508 + parent 3953497)
2. Restart the gateway: `systemctl --user start openclaw-gateway.service`
3. Clean orphaned restart scripts: `rm /tmp/openclaw-restart-*.sh`
