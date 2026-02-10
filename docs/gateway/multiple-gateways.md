---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Run multiple OpenClaw Gateways on one host (isolation, ports, and profiles)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Running more than one Gateway on the same machine（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need isolated config/state/ports per Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Multiple Gateways"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Multiple Gateways (same host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Most setups should use one Gateway because a single Gateway can handle multiple messaging connections and agents. If you need stronger isolation or redundancy (e.g., a rescue bot), run separate Gateways with isolated profiles/ports.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Isolation checklist (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_CONFIG_PATH` — per-instance config file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_STATE_DIR` — per-instance sessions, creds, caches（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.workspace` — per-instance workspace root（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.port` (or `--port`) — unique per instance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Derived ports (browser/canvas) must not overlap（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If these are shared, you will hit config races and port conflicts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Recommended: profiles (`--profile`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Profiles auto-scope `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` and suffix service names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile main setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile main gateway --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# rescue（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile rescue setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile rescue gateway --port 19001（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-profile services:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile main gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile rescue gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Rescue-bot guide（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run a second Gateway on the same host with its own:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- profile/config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- state dir（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- base port (plus derived ports)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This keeps the rescue bot isolated from the main bot so it can debug or apply config changes if the primary bot is down.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Port spacing: leave at least 20 ports between base ports so the derived browser/canvas/CDP ports never collide.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How to install (rescue bot)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Main bot (existing or fresh, without --profile param)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Runs on port 18789 + Chrome CDC/Canvas/... Ports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Rescue bot (isolated profile + ports)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile rescue onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# - workspace name will be postfixed with -rescue per default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# - Port should be at least 18789 + 20 Ports,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#   better choose completely different base port, like 19789,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# - rest of the onboarding is the same as normal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# To install the service (if not happened automatically during onboarding)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile rescue gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Port mapping (derived)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Base port = `gateway.port` (or `OPENCLAW_GATEWAY_PORT` / `--port`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- browser control service port = base + 2 (loopback only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `canvasHost.port = base + 4`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser profile CDP ports auto-allocate from `browser.controlPort + 9 .. + 108`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you override any of these in config or env, you must keep them unique per instance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Browser/CDP notes (common footgun)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do **not** pin `browser.cdpUrl` to the same values on multiple instances.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each instance needs its own browser control port and CDP range (derived from its gateway port).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you need explicit CDP ports, set `browser.profiles.<name>.cdpPort` per instance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remote Chrome: use `browser.profiles.<name>.cdpUrl` (per profile, per instance).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Manual env example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_STATE_DIR=~/.openclaw-main \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_STATE_DIR=~/.openclaw-rescue \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --port 19001（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick checks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile main status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile rescue status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile rescue browser status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
