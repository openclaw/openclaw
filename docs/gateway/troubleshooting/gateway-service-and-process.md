---
summary: "The managed gateway service not running, macOS launchd faults, and high-memory exits"
title: "Gateway service and process"
sidebarTitle: "Gateway service and process"
read_when:
  - The gateway service is not running or will not stay up
  - A macOS Gateway stalls until you touch the dashboard, or duplicate LaunchAgents fight each other
  - The Gateway exits under high memory use and you need heap sizing guidance
---

## Gateway service not running

Use when the service is installed but the process does not stay up.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep   # also scan system-level services
```

Look for:

- `Runtime: stopped` with exit hints.
- Service config mismatch (`Config (cli)` vs `Config (service)`).
- Port/listener conflicts.
- Extra launchd/systemd/schtasks installs when `--deep` is used.
- `Other gateway-like services detected (best effort)` cleanup hints.

<AccordionGroup>
  <Accordion title="Common signatures">
    - `Gateway start blocked: set gateway.mode=local` or `existing config is missing gateway.mode` → local gateway mode is not enabled, or the config file was clobbered and lost `gateway.mode`. Fix: set `gateway.mode="local"` in your config, or re-run `openclaw onboard --mode local` / `openclaw setup` to restamp the expected local-mode config. If you are running OpenClaw via Podman, the default config path is `~/.openclaw/openclaw.json`.
    - `refusing to bind gateway ... without auth` → non-loopback bind without a valid gateway auth path (token/password, or trusted-proxy where configured).
    - `another gateway instance is already listening` / `EADDRINUSE` → port conflict.
    - `Other gateway-like services detected (best effort)` → stale or parallel launchd/systemd/schtasks units exist. Most setups should keep one gateway per machine; if you do need more than one, isolate ports + config/state/workspace. See [/gateway#multiple-gateways-same-host](/gateway#multiple-gateways-same-host).
    - `System-level OpenClaw gateway service detected` from doctor → a systemd system unit exists while the user-level service is missing. Remove or disable the duplicate before allowing doctor to install a user service, or set `OPENCLAW_SERVICE_REPAIR_POLICY=external` if the system unit is the intended supervisor.
    - `Gateway service port does not match current gateway config` → the installed supervisor still pins the old `--port`. Run `openclaw doctor --fix` or `openclaw gateway install --force`, then restart the gateway service.

  </Accordion>
</AccordionGroup>

Related:

- [Background exec and process tool](/gateway/background-process)
- [Configuration](/gateway/configuration)
- [Doctor](/gateway/doctor)

## macOS gateway silently stops responding, then resumes when you touch the dashboard

Use when channels (Telegram, WhatsApp, etc.) on a macOS host go quiet for minutes to hours at a time, and the gateway appears to come back the moment you open the Control UI, SSH in, or otherwise interact with the host. There is usually no obvious symptom in `openclaw status` because by the time you look the gateway is alive again.

```bash
ls ~/.openclaw/logs/stability/ | tail -5
openclaw gateway stability --bundle latest
pmset -g log | grep -iE "sleep|wake|maintenance" | tail -50
launchctl print gui/$UID/ai.openclaw.gateway | grep -E "state|last exit|runs"
```

Look for:

- One or more `*-uncaught_exception.json` bundles in `~/.openclaw/logs/stability/` with `error.code` set to a transient network code such as `ENETDOWN`, `ENETUNREACH`, `EHOSTUNREACH`, or `ECONNREFUSED`.
- `pmset -g log` lines like `Entering Sleep state due to 'Maintenance Sleep'` or `en0 driver is slow (msg: WillChangeState to 0)` aligned with the crash timestamps. Power Nap / Maintenance Sleep briefly puts the Wi-Fi driver into state 0; any outbound `connect()` that lands in that window can fail with `ENETDOWN` even on a host that otherwise has full network connectivity.
- `launchctl print` output showing `state = not running` with multiple recent `runs` and an exit code, especially when the gap between crash and the next launch is on the order of an hour rather than seconds. macOS launchd applies an undocumented respawn-protection gate after a crash burst that can stop honoring `KeepAlive=true` until an external trigger such as interactive login, dashboard connection, or `launchctl kickstart` re-arms it.

Common signatures:

- A stability bundle whose `error.code` is `ENETDOWN` or a sibling code, with the call stack pointing into Node `net` `lookupAndConnect` / `Socket.connect`. OpenClaw `2026.5.26` and newer classify these as benign transient network errors so they no longer propagate to the top-level uncaught handler; if you are on an older release, upgrade first.
- Long quiet periods that end the instant you connect to the Control UI or SSH into the host: the user-visible activity is what re-arms launchd's respawn gate, not anything the dashboard does to the gateway.
- `runs` count incrementing across the day with no corresponding `received SIG*; shutting down` line in `~/Library/Logs/openclaw/gateway.log`: clean shutdowns log a signal; transient crashes do not.

What to do:

1. **Upgrade the gateway** if you are running a release before `2026.5.26`. After upgrading, future `ENETDOWN` errors are logged as warnings instead of terminating the process.
2. **Reduce maintenance sleep activity** on Mac mini / desktop hosts meant to run as always-on servers:

   ```bash
   sudo pmset -a sleep 0 disksleep 0 standby 0 powernap 0
   ```

   This significantly reduces, but does not entirely eliminate, the underlying driver flap. The system can still perform some maintenance sleeps for TCP keepalive and mDNS upkeep regardless of these flags.

3. **Add a liveness watchdog** so a future crash burst that gets parked by launchd is caught quickly:

   ```bash
   # Example launchd-aware liveness check, suitable for a 5-minute cron or LaunchAgent
   state=$(launchctl print gui/$UID/ai.openclaw.gateway 2>/dev/null | awk -F'= ' '/state =/ {print $2; exit}')
   if [ "$state" != "running" ]; then
     launchctl kickstart -k gui/$UID/ai.openclaw.gateway
   fi
   ```

   The point is to externally re-arm the respawn gate; `KeepAlive=true` alone is not sufficient on macOS after a crash burst.

Related:

- [macOS platform notes](/platforms/macos)
- [Logging](/logging)
- [Doctor](/gateway/doctor)

## macOS launchd supervisor loop with duplicate gateway/node LaunchAgents

Use this when a macOS install keeps restarting every few seconds, `openclaw`
health checks flap between healthy and unavailable, and channel dispatch stalls
even though the service appears to be running.

This was observed on older installs where both `ai.openclaw.gateway` and
`ai.openclaw.node` LaunchAgents were active and each injected
`OPENCLAW_LAUNCHD_LABEL`. In that state OpenClaw can detect launchd
supervision, try to hand restart back to launchd, and fall into a fast
`EADDRINUSE`/respawn loop instead of one stable gateway process.

```bash
for i in 1 2 3 4; do
  ps aux | grep 'openclaw.*index.js' | grep -v grep | awk '{print $2}'
  sleep 10
done

openclaw gateway status --deep
openclaw node status
launchctl print gui/$UID/ai.openclaw.gateway | grep -E 'state|last exit|runs'
tail -n 80 ~/Library/Logs/openclaw/gateway.log
```

Look for:

- More than one gateway PID across the 30-second sample instead of one stable
  process.
- `EADDRINUSE`, `another gateway instance is already listening`, or repeated
  restart/handoff lines in `gateway.log`.
- Both `~/Library/LaunchAgents/ai.openclaw.gateway.plist` and
  `~/Library/LaunchAgents/ai.openclaw.node.plist` loaded at the same time on a
  host that should only run one managed gateway service.

What to do:

1. If this host should only run the Gateway service, remove the managed node
   service through OpenClaw. **Skip this step** if you actively rely on the node
   service for remote node features; uninstalling it stops those features on
   this host:

   ```bash
   openclaw node uninstall
   ```

2. Install a persistent Gateway wrapper that clears the inherited launchd
   markers before starting OpenClaw. Use the supported `--wrapper` option; do
   not edit the generated file under `~/.openclaw/service-env/`, because service
   reinstall, update, and doctor repair regenerate that file:

   ```bash
   mkdir -p ~/.local/bin
   cat >~/.local/bin/openclaw-launchd-workaround <<'EOF'
   #!/bin/sh
   set -eu
   unset OPENCLAW_LAUNCHD_LABEL LAUNCH_JOB_LABEL LAUNCH_JOB_NAME XPC_SERVICE_NAME || true
   exec openclaw "$@"
   EOF
   chmod 700 ~/.local/bin/openclaw-launchd-workaround

   openclaw gateway install \
     --wrapper ~/.local/bin/openclaw-launchd-workaround \
     --force
   ```

   `gateway install` persists the wrapper path across forced reinstalls,
   updates, and doctor repairs.

3. Verify that the Gateway is stable and serving RPC, not merely listening:

   ```bash
   openclaw gateway status --deep --require-rpc

   for i in 1 2 3 4; do
     ps aux | grep 'openclaw.*index.js' | grep -v grep | awk '{print $2}'
     sleep 10
   done
   ```

   The PID sample should show one stable process instead of a rotating set of
   PIDs, and inbound channel dispatch should resume.

4. After upgrading to a release where the underlying dual-LaunchAgent loop is
   fixed, remove the workaround and reinstall the normal managed service:

   ```bash
   OPENCLAW_WRAPPER= openclaw gateway install --force
   rm ~/.local/bin/openclaw-launchd-workaround
   ```

Related:

- [macOS platform notes](/platforms/mac/bundled-gateway)
- [Doctor](/gateway/doctor)
- [Gateway CLI](/cli/gateway)

## Gateway exits during high memory use

Use when the Gateway disappears under load, the supervisor reports an OOM-style restart, or logs mention `critical memory pressure bundle written`.

```bash
openclaw gateway status --deep
openclaw logs --follow
openclaw gateway stability --bundle latest
openclaw gateway diagnostics export
```

Look for:

- `Reason: diagnostic.memory.pressure.critical` in the latest stability bundle.
- `Memory pressure:` with `critical/rss_threshold`, `critical/heap_threshold`, or `critical/rss_growth`.
- `V8 heap:` values near the heap limit.
- `Largest session files:` entries such as `agents/<agent>/sessions/<session>.jsonl` or `sessions/<session>.jsonl`.
- Linux cgroup memory counters when the gateway runs inside a container or memory-limited service.

Common signatures:

- `critical memory pressure bundle written` appears shortly before restart → OpenClaw captured a pre-OOM stability bundle. Inspect it with `openclaw gateway stability --bundle latest`.
- `memory pressure: level=critical` appears in gateway logs → OpenClaw detected critical memory pressure and recorded the available in-process memory facts.
- `Largest session files:` points at a very large redacted transcript path → reduce retained session history, inspect session growth, or move old transcripts out of the active store before restarting.
- `V8 heap:` used bytes are close to the heap limit → lower prompt/session pressure or reduce concurrent work first. For a managed service, compare the configured controls and install-time recommendation in `Gateway heap:` from `openclaw gateway status` with the runtime measurement. Reinstalling preserves existing stored heap settings; it does not automatically replace an older value with the current recommendation.
- `Memory pressure: critical/rss_growth` → memory grew quickly inside one sampling window. Check the latest logs for a large import, runaway tool output, repeated retries, or a batch of queued agent work.
- Critical memory pressure appears in logs but no bundle exists → capture `openclaw gateway diagnostics export` after the event for the available operational evidence.

The stability bundle is payload-free. It includes operational memory evidence and redacted relative file paths, not message text, webhook bodies, credentials, tokens, cookies, or raw session ids. Attach the diagnostics export to bug reports instead of copying raw logs.

Node's automatic heap ceiling can be roughly 4 GiB on a large host. That is a default sizing decision, not a general 64-bit address-space ceiling. `--max-old-space-size` controls V8 old space; the measured total V8 heap ceiling also includes other heap spaces. RSS additionally includes native allocations, buffers, and other process memory. A higher heap ceiling does not preallocate the ceiling, but it still needs enough real capacity and headroom under sustained load.

For a foreground Node Gateway, set a native heap flag before Node starts, for example on a host with sufficient capacity:

```bash
NODE_OPTIONS="--max-old-space-size=16384" openclaw gateway run
```

For a custom supervisor or Docker runtime command, place `--max-old-space-size=16384` immediately after `node`, before the OpenClaw entry script, or set `NODE_OPTIONS` in that process or container's launch environment. Docker image build-time heap options do not configure the runtime Gateway. An OpenClaw config or dotenv value loaded after Node starts cannot resize its heap. `NODE_OPTIONS` can also reach spawned Node children, so prefer a direct Node argument when only the Gateway should receive the budget.

For managed Node services, use the [managed Gateway heap policy](/cli/gateway#manage-the-gateway-service) and inspect both managed launch arguments and operator-owned environment overrides before changing them. Native argv overrides the same option in `NODE_OPTIONS`; percentage old-space sizing takes precedence over absolute old-space sizing. Regeneration preserves stored argv but does not add an automatic heap flag when an operator override owns `NODE_OPTIONS`. Installer-shell `NODE_OPTIONS` does not become a service override. Runtime pressure diagnostics use the effective V8 heap ceiling and physical/reported constraint headroom; an oversized explicit heap setting does not raise the RSS alert threshold above physical capacity. Pressure warnings are diagnostic evidence, not heap limits or automatic restart triggers.

Related:

- [Gateway health](/gateway/health)
- [Diagnostics export](/gateway/diagnostics)
- [Sessions](/cli/sessions)
