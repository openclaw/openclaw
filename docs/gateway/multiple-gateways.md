---
summary: "Run multiple OpenClaw Gateways on one host (isolation, ports, and profiles)"
read_when:
  - Running more than one Gateway on the same machine
  - You need isolated config/state/ports per Gateway
title: "Multiple gateways"
doc-schema-version: 1
---

Most setups need one Gateway - a single Gateway handles multiple messaging connections and agents. Run separate Gateways with isolated profiles/ports only when you need stronger isolation or redundancy (e.g., a rescue bot).

## Rescue-bot quickstart

The simplest rescue-bot setup:

- Keep the main bot on the default profile.
- Run the rescue bot on `--profile rescue`, with its own Telegram bot token.
- Put the rescue bot on a different base port, e.g. `19789`.

This keeps the rescue bot able to debug or apply config changes if the primary bot is down. Leave at least 120 ports between base ports so derived sandbox/browser/CDP ports never collide. Each instance reaches base + 110: its browser control port is base + 2, and that port's CDP range runs to base + 110.

```bash
# Rescue bot (separate Telegram bot, separate profile, port 19789)
openclaw --profile rescue onboard
openclaw --profile rescue gateway install --port 19789
```

If your main bot is already running, that's usually all you need. If onboarding already installed the rescue service, skip the final `gateway install`.

During `openclaw --profile rescue onboard`:

- Use a separate Telegram bot token, dedicated to the rescue account. It is easy to keep operator-only, it stays independent from the main bot's channel and app install, and it gives a simple DM-based recovery path.
- Keep the `rescue` profile name.
- Use a base port at least 120 higher than the main bot.
- Accept the default rescue workspace unless you already manage one yourself.

### What `--profile rescue onboard` changes

`--profile rescue onboard` runs the normal onboarding flow but writes everything into a separate profile, so the rescue bot gets its own:

- Profile/config file
- State directory
- Workspace (default: `~/.openclaw/workspace-rescue`)
- Managed service name
- Base port (plus derived ports)
- Telegram bot token

Prompts are otherwise identical to normal onboarding.

## General multi-gateway setup

The same isolation pattern works for any pair or group of Gateways on one host. Give each extra Gateway its own named profile and base port.

`openclaw setup` runs onboarding on a profile that is not configured yet. It does the same first-run job as the `onboard` command used for the rescue bot above. Use `onboard` when you want the onboarding flow on a profile that is already configured.

```bash
# main (default profile)
openclaw setup
openclaw gateway --port 18789

# extra gateway
openclaw --profile ops setup
openclaw --profile ops gateway --port 19789
```

Named profiles on both sides also work:

```bash
openclaw --profile main setup
openclaw --profile main gateway --port 18789

openclaw --profile ops setup
openclaw --profile ops gateway --port 19789
```

Services follow the same pattern:

```bash
openclaw gateway install
openclaw --profile ops gateway install --port 19789
```

Use the rescue-bot quickstart for a fallback operator lane. Use the general profile pattern for multiple long-lived Gateways across different channels, tenants, workspaces, or operational roles.

## Isolation checklist

Keep these unique per Gateway instance:

| Setting                           | Purpose                              |
| --------------------------------- | ------------------------------------ |
| `OPENCLAW_CONFIG_PATH`            | Per-instance config file             |
| `OPENCLAW_STATE_DIR`              | Per-instance sessions, creds, caches |
| `agents.defaults.workspace`       | Per-instance workspace root          |
| `gateway.port` (or `--port`)      | Unique per instance                  |
| Derived sandbox/browser/CDP ports | See below                            |

Sharing any of these causes config, state, or port conflicts. Gateway startup
enforces unique state-directory ownership, including when
`OPENCLAW_ALLOW_MULTI_GATEWAY=1` is set.

<Warning>
`OPENCLAW_STATE_DIR` alone does not isolate a managed Gateway service. Service names follow the profile, not the state directory. For onboarding or service-install tests, use a dedicated named profile and unique ports, or an isolated machine. Do not install or restart the default service against a temporary state directory.
</Warning>

## Port mapping (derived)

Base port = `gateway.port` (or `OPENCLAW_GATEWAY_PORT` / `--port`).

- Sandbox host listener port = base + 1 when the isolated widget/MCP App host is active (unless `mcp.apps.sandboxPort` overrides it).
- Browser control service port = base + 2 (loopback only).
- Hosted widget documents are served on the Gateway HTTP server itself (same port as `gateway.port`).
- Browser profile CDP ports auto-allocate from `browser control port + 9` through `+ 108`.

Override any of these in config or env and you must keep them unique per instance.

## Browser/CDP notes (common footgun)

- Do **not** pin `browser.cdpUrl` to the same value on multiple instances.
- Each instance needs its own browser control port and CDP range (derived from its gateway port).
- For explicit CDP ports, set `browser.profiles.<name>.cdpPort` per instance.
- For remote Chrome, use `browser.profiles.<name>.cdpUrl` (per profile, per instance).

## Manual env example

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19789
```

## Quick checks

```bash
openclaw gateway status --deep
openclaw --profile rescue gateway status --deep
openclaw --profile rescue gateway probe
openclaw status
openclaw --profile rescue status
openclaw --profile rescue browser status
```

- `gateway status --deep` catches stale launchd/systemd/schtasks services from older installs.
- `doctor --deep` also reports when a recognizable service definition or native service manager could not be inspected. Restore inspection access and rerun Doctor; an incomplete scan does not prove that no other service exists. Inspection warnings never authorize service cleanup.
- `gateway probe` warning text such as `multiple reachable gateway identities detected` is expected in two cases. You intentionally run more than one isolated gateway, or OpenClaw cannot prove that reachable check targets are the same gateway. An SSH tunnel, proxy URL, or configured remote URL to the same gateway is one gateway with multiple transports, even when transport ports differ.

## Windows notes

Two Gateways on one Windows host work, but Windows adds a few behaviors that are
easy to miss and expensive to diagnose.

### Launch the second Gateway from a clean environment

Prefer the named-profile workflow for the second instance:

```bat
openclaw --profile ops gateway --port 19789
```

A launcher that starts from a shell inside the first Gateway's process inherits
`OPENCLAW_PROFILE`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`,
`OPENCLAW_GATEWAY_PORT`, and the `OPENCLAW_SERVICE_*` variables. Keeping them
starts the first instance's config, state, and port a second time, and the child
loses to state-directory ownership or the busy port.

If one launcher must start both instances, pin separate paths and a separate
base port for the second one:

```bat
set "OPENCLAW_STATE_DIR=C:\Users\<you>\.openclaw-ops"
set "OPENCLAW_CONFIG_PATH=C:\Users\<you>\.openclaw-ops\openclaw.json"
set "OPENCLAW_GATEWAY_PORT=19789"
"<node.exe>" "<openclaw>\dist\index.js" gateway
```

Symptom to recognize: the second instance's startup log names the first
instance's state directory, or it refuses to start because that directory is
already owned.

### A copied config also copies `gateway.tailscale.mode`

If one instance sets `gateway.tailscale.mode: "serve"`, a copied config gives the
second instance the same mode. Port 443 is already bound by the first instance,
so the second exits with code 78. Set `gateway.tailscale.mode: "off"` on every
instance that must not publish itself.

### npm installs require Node `>=24.22.1 <25 || >=26.12.1`

The published package declares that engines range. A version manager without a
matching shim fails the install even when a suitable runtime is already on disk.
Unpack a portable Node in range, point the launcher at that `node.exe`, and
install into a dedicated prefix:

```bat
npm i -g --prefix "D:\Program Files\openclaw" openclaw
```

### Scheduled-task ACLs block non-elevated changes

A task registered from an elevated shell grants the interactive user read-only
access (`FR`). Reading still works, but changing or disabling it fails with
*Access is denied* / `0x80070005`:

```powershell
(Get-ScheduledTask -TaskName 'OpenClaw Gateway').Actions   # works
Disable-ScheduledTask -TaskName 'OpenClaw Gateway'         # denied
```

Either register the task under the account and integrity level that will manage
it later, keep an elevated shell for task changes, or leave a no-op launcher at
the task's target path as a documented soft-disable (the task starts, logs, and
exits `0`).

### A 200 on `/` does not prove token isolation

The UI and health endpoints answer before RPC authentication, so every reachable
port looks up even when the token is wrong. Prove isolation with an authenticated
RPC call in both directions; a foreign token must be rejected:

```powershell
openclaw gateway call health --url ws://127.0.0.1:18800 --token <token-of-other-instance> --json
```

## Related

- [Gateway runbook](/gateway)
- [Gateway lock](/gateway/gateway-lock)
- [Configuration](/gateway/configuration)
