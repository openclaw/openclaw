---
summary: "Run multiple OpenClaw Gateways on one host (isolation, ports, and profiles)"
read_when:
  - Running more than one Gateway on the same machine
  - You need isolated config/state/ports per Gateway
title: "Multiple Gateways"
---

# Multiple Gateways (same host)

Most setups should use one Gateway because a single Gateway can handle multiple messaging connections and agents. If you need stronger isolation or redundancy (e.g., a rescue bot), run separate Gateways with isolated profiles/ports.

## Isolation checklist (required)

- `OPENCLAW_CONFIG_PATH` — per-instance config file
- `OPENCLAW_STATE_DIR` — per-instance sessions, creds, caches
- `agents.defaults.workspace` — per-instance workspace root
- `gateway.port` (or `--port`) — unique per instance
- Derived ports (browser/canvas) must not overlap

If these are shared, you will hit config races and port conflicts.

## Recommended: profiles (`--profile`)

Profiles auto-scope `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` and suffix service names.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Per-profile services:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Rescue-bot guide

Run a second Gateway on the same host with its own:

- profile/config
- state dir
- workspace
- base port (plus derived ports)

This keeps the rescue bot isolated from the main bot so it can debug or apply config changes if the primary bot is down.

Port spacing: leave at least 20 ports between base ports so the derived browser/canvas/CDP ports never collide.

### How to install (rescue bot)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## Port mapping (derived)

Base port = `gateway.port` (or `OPENCLAW_GATEWAY_PORT` / `--port`).

- browser control service port = base + 2 (loopback only)
- `canvasHost.port = base + 4`
- Browser profile CDP ports auto-allocate from `browser.controlPort + 9 .. + 108`

If you override any of these in config or env, you must keep them unique per instance.

## Browser/CDP notes (common footgun)

- Do **not** pin `browser.cdpUrl` to the same values on multiple instances.
- Each instance needs its own browser control port and CDP range (derived from its gateway port).
- If you need explicit CDP ports, set `browser.profiles.<name>.cdpPort` per instance.
- Remote Chrome: use `browser.profiles.<name>.cdpUrl` (per profile, per instance).

## Manual env example

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Quick checks

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```

## High availability (multiple instances, same webhook)

When you run **multiple Gateway instances** for HA (e.g. behind a load balancer), the same webhook (Telegram, etc.) is delivered to every instance. Without coordination, each instance would process the same message, causing duplicate AI runs and token waste (e.g. 5–10K tokens per duplicate heartbeat).

Configure **cross-instance inbound deduplication** so only one instance processes each message:

```json5
{
  gateway: {
    inboundDedupe: {
      file: { dir: "/var/lib/openclaw/inbound-claim" },
    },
  },
}
```

- **`gateway.inboundDedupe`** (optional):
  - Omitted or `"memory"`: in-process dedupe only (single Gateway; default).
  - **`{ file: { dir: "<path>" } }`**: use a **shared directory** so all instances coordinate. The first instance to "claim" a message processes it; others skip. The directory must be readable and writable by all Gateway processes (e.g. NFS or a path on shared storage). Claim files are pruned automatically after 5 minutes.

Use a path that is the same on every instance (e.g. NFS mount or a shared volume). Do not use a local-only path when instances run on different hosts.
