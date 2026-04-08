---
title: "fix: Gateway Watchdog Timer + Auditd — Prevent Recurring Service Death"
type: fix
priority: P0
status: completed
origin: docs/brainstorms/2026-04-08-gateway-sleep-rca-brainstorm.md
created: 2026-04-08
---

# Gateway Watchdog Timer + Auditd

## Summary

The OpenClaw gateway repeatedly "falls asleep" because `Restart=always` in the systemd unit doesn't cover explicit `systemctl --user stop` commands. This plan adds a companion systemd watchdog timer that auto-restarts the gateway when it's dead, plus auditd rules to trace future stop triggers. Also includes immediate triage (kill stuck processes, restart gateway, clean orphans).

**Key decisions carried forward from brainstorm:**

- Watchdog timer interval: 60 seconds (see brainstorm: Key Decisions #1)
- Health check method: HTTP probe on `/health` endpoint (see brainstorm: Key Decisions #2)
- Recovery action: `systemctl --user start` not restart (see brainstorm: Key Decisions #3)
- Install auditd with UID 1003 systemctl audit rule (see brainstorm: Key Decisions #4)
- Rejected: WatchdogSec, RefuseManualStop, cron band-aid (see brainstorm: Rejected Alternatives)

## Scope

**In scope:**

- Phase 0: Immediate triage (kill stuck processes, restart gateway, clean orphans)
- Phase 1: Create and install watchdog timer + service unit files on the homelab
- Phase 2: Install auditd and add systemctl audit rule

**Out of scope:**

- Codifying the watchdog timer into the `src/daemon/systemd-unit.ts` generator (future work — this plan is homelab-only)
- WatchdogSec / sd_notify integration (rejected in brainstorm)
- Fixing the stuck onboard infinite loop root cause (separate issue)
- Fixing orphaned restart script cleanup in update-cli (separate issue)

## Acceptance Criteria

- [ ] Gateway is running and responding to Telegram messages
- [ ] Stuck `openclaw-onboard` process is killed
- [ ] Orphaned `/tmp/openclaw-restart-*.sh` scripts are cleaned
- [ ] `openclaw-gateway-watchdog.timer` is enabled and active
- [ ] `openclaw-gateway-watchdog.service` correctly probes `/health` and starts the gateway if dead
- [ ] Watchdog recovers the gateway within 90 seconds of an explicit `systemctl --user stop`
- [ ] `systemctl --user start openclaw-gateway.service` on an already-running gateway is a no-op (verified)
- [ ] auditd is installed and logging systemctl calls for UID 1003
- [ ] Homelab docs updated at `/home/codex/second-brain/projects/homelab/`

## Phased Implementation

### Phase 0: Immediate Triage

> Priority: Do this first. Gateway has been dead 3+ hours.

**Step 0.1: Kill stuck onboard process**

```bash
# Document state first
ps aux | grep 3953508
cat /proc/3953508/status | grep -E "State|VmRSS|Threads"

# Kill child first, then parent
kill -TERM 3953508  # openclaw-onboard (stuck child)
sleep 2
kill -TERM 3953497  # openclaw (sleeping parent)

# Verify
ps aux | grep -E "3953508|3953497" | grep -v grep
```

**Step 0.2: Clean orphaned restart scripts**

```bash
ls -la /tmp/openclaw-restart-*.sh
rm -f /tmp/openclaw-restart-*.sh
```

**Step 0.3: Restart gateway**

```bash
systemctl --user start openclaw-gateway.service
systemctl --user status openclaw-gateway.service

# Verify health
sleep 5
curl -sf http://localhost:18789/health && echo "OK" || echo "FAIL"
```

**Verification gate:** Gateway status is `active (running)` and `/health` returns OK.

---

### Phase 1: Watchdog Timer Unit

> Priority: Core fix. Prevents recurrence.

**Step 1.1: Create the watchdog service unit**

File: `~/.config/systemd/user/openclaw-gateway-watchdog.service`

```ini
[Unit]
Description=OpenClaw Gateway Watchdog
# No dependency on the gateway — this must run even when gateway is dead

[Service]
Type=oneshot
# Probe the health endpoint. If it fails (gateway dead), start the service.
# curl -sf: silent + fail on HTTP errors. Returns non-zero if gateway unreachable.
ExecStart=/bin/sh -c 'curl -sf --max-time 5 http://localhost:18789/health > /dev/null 2>&1 || systemctl --user start openclaw-gateway.service'

# No [Install] — activated only by the timer
```

**Design notes:**

- `Type=oneshot` — runs once per timer tick, exits immediately
- `curl --max-time 5` — 5s timeout prevents watchdog from hanging if gateway is stuck
- `systemctl start` (not restart) — no-op if gateway is already running, safe to call unconditionally
- No `Requires=` or `After=` on the gateway — the watchdog must run independently

**Step 1.2: Create the watchdog timer unit**

File: `~/.config/systemd/user/openclaw-gateway-watchdog.timer`

```ini
[Unit]
Description=OpenClaw Gateway Watchdog Timer

[Timer]
OnBootSec=30
OnUnitActiveSec=60
AccuracySec=5

[Install]
WantedBy=timers.target
```

**Design notes:**

- `OnBootSec=30` — first check 30s after user session starts (gives gateway time to boot)
- `OnUnitActiveSec=60` — then every 60 seconds
- `AccuracySec=5` — allow up to 5s coalescing with other timers (battery/CPU friendly)
- `WantedBy=timers.target` — auto-starts on login (with linger, this means always)

**Step 1.3: Install and activate**

```bash
# Write unit files (already done in 1.1/1.2)
# Reload systemd
systemctl --user daemon-reload

# Enable and start the timer
systemctl --user enable --now openclaw-gateway-watchdog.timer

# Verify timer is active
systemctl --user status openclaw-gateway-watchdog.timer
systemctl --user list-timers | grep watchdog
```

**Step 1.4: Verify recovery**

```bash
# Stop the gateway intentionally
systemctl --user stop openclaw-gateway.service

# Wait 90 seconds (60s timer + up to 30s for first tick)
echo "Waiting 90s for watchdog recovery..."
sleep 90

# Check if watchdog restarted it
systemctl --user status openclaw-gateway.service
curl -sf http://localhost:18789/health && echo "RECOVERED" || echo "STILL DEAD"

# Check watchdog journal for the restart
journalctl --user -u openclaw-gateway-watchdog.service --since "2 minutes ago" --no-pager
```

**Verification gate:** Gateway auto-recovers within 90 seconds of explicit stop.

**Edge cases considered (from SpecFlow):**

- **During updates:** `openclaw update` issues `systemctl restart` (atomic stop+start). The watchdog may fire during the 1-2s restart window, but `systemctl start` on a starting service is harmless (already queued).
- **During uninstall:** `openclaw uninstall` disables the main service AND the watchdog timer should be removed too. Add a note to uninstall docs.
- **Timer itself dies:** `timers.target` ensures the timer is restarted with the user session. Linger keeps the session alive.
- **Boot race:** `OnBootSec=30` gives the gateway 30s to start on its own before the watchdog kicks in.

---

### Phase 2: Auditd Installation

> Priority: Diagnostic. Traces future stop triggers.

**Step 2.1: Install auditd**

```bash
sudo apt-get install -y auditd audispd-plugins
sudo systemctl enable --now auditd
```

**Step 2.2: Add systemctl audit rule**

```bash
# Audit all systemctl invocations by UID 1003 (codex user)
sudo auditctl -a always,exit -F arch=b64 -S execve -F uid=1003 -F exe=/usr/bin/systemctl -k openclaw-systemctl

# Make persistent across reboots
echo '-a always,exit -F arch=b64 -S execve -F uid=1003 -F exe=/usr/bin/systemctl -k openclaw-systemctl' | sudo tee -a /etc/audit/rules.d/openclaw.rules

# Reload rules
sudo augenrules --load
```

**Step 2.3: Verify audit logging**

```bash
# Trigger a test event
systemctl --user status openclaw-gateway.service

# Check audit log
sudo ausearch -k openclaw-systemctl --start recent
```

**Verification gate:** `ausearch` shows the test systemctl command with full command line and calling PID.

**Note on log rotation:** auditd rotates logs automatically via `/etc/audit/auditd.conf` (`max_log_file` and `num_logs`). Default is 8MB x 5 files = 40MB. Sufficient for this use case.

---

### Phase 3: Documentation

> Priority: Required by homelab CLAUDE.md rules.

**Step 3.1: Update homelab docs**

Update `/home/codex/second-brain/projects/homelab/`:

- `services/openclaw.md` — add watchdog timer section
- `LOG.md` — add today's entry documenting the RCA and fix
- `infrastructure/security.md` — add auditd rule documentation

**Step 3.2: Commit and push**

```bash
cd /home/codex/second-brain
git add -A && git commit -m "docs: add openclaw watchdog timer + auditd RCA"
git push
```

## Rollback

**If watchdog causes problems (restart loops, etc.):**

```bash
# Disable the watchdog timer
systemctl --user disable --now openclaw-gateway-watchdog.timer

# Remove unit files
rm ~/.config/systemd/user/openclaw-gateway-watchdog.{timer,service}
systemctl --user daemon-reload
```

**If auditd causes performance issues:**

```bash
sudo auditctl -d always,exit -F arch=b64 -S execve -F uid=1003 -F exe=/usr/bin/systemctl -k openclaw-systemctl
sudo rm /etc/audit/rules.d/openclaw.rules
sudo augenrules --load
```

## Future Work (Not This Plan)

- **Codify watchdog in `src/daemon/systemd-unit.ts`** — generate the timer unit alongside the main service unit so all OpenClaw installs get it automatically
- **Fix `openclaw uninstall` to also remove watchdog units** — currently only removes the main service
- **Investigate stuck `openclaw-onboard` infinite loop** — root cause is unknown, needs separate debugging
- **Fix orphaned restart script cleanup in update-cli** — `prepareRestartScript` writes scripts that may never execute or self-clean
- **Add `WatchdogSec` + `sd_notify` for hung process detection** — complementary to the timer, catches partially-dead gateway

## Sources

- **Origin brainstorm:** `docs/brainstorms/2026-04-08-gateway-sleep-rca-brainstorm.md` — full RCA timeline, evidence, root cause analysis, approach comparison, key decisions
- **Prior remediation plan:** `docs/plans/2026-04-08-001-fix-openclaw-health-audit-remediation-plan.md` — recommended systemd hardening (WatchdogSec, StartLimitIntervalSec, RefuseManualStop) but none implemented
- **Systemd unit generator:** `src/daemon/systemd-unit.ts:38` (`buildSystemdUnit`)
- **Service management:** `src/daemon/systemd.ts` (install, uninstall, stop, restart)
- **Health endpoints:** `src/gateway/server-http.ts:131-136` (`/health`, `/healthz`, `/ready`, `/readyz`)
- **Gateway service name:** `src/daemon/constants.ts:5` (`GATEWAY_SYSTEMD_SERVICE_NAME = "openclaw-gateway"`)
- **Restart infrastructure:** `src/infra/restart.ts` (SIGUSR1 scheduling, `triggerOpenClawRestart`)
- **Update restart scripts:** `src/cli/update-cli/restart-helper.ts` (orphaned script root cause)
