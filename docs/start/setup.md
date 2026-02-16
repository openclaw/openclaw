---
summary: "Advanced setup and deployment workflows for OpenClaw"
read_when:
  - Setting up a new machine
  - You want “latest + greatest” without breaking your personal setup
  - Running a remote Gateway on a server
  - Planning backups and state locations
title: "Setup"
---

# Setup

<Note>
If you are setting up for the first time, start with [Getting Started](/start/getting-started).
For wizard details, see [Onboarding Wizard](/start/wizard).
</Note>

Last updated: 2026-02-15

## TL;DR

- **Tailoring lives outside the repo:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (config).
- **Deployment-first:** run the Gateway via the CLI or a service manager (launchd/systemd). App development is out of scope here.
- **Remote access:** prefer Tailscale Serve/Funnel or SSH tunnels; keep auth enabled.

## Deployment paths

### Local host (recommended)

Install the CLI and run the onboarding wizard to install a background service:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Start/stop the Gateway as needed:

```bash
openclaw gateway --port 18789 --verbose
```

### Remote Gateway (server)

For a small Linux VM or headless host:

1. Install the CLI (or use Docker).
2. Bind to a secure interface and keep auth enabled.
3. Expose access with Tailscale or SSH tunnels.

Example (tailnet-only bind):

```bash
openclaw gateway --bind tailnet --port 18789
```

Details: [Remote access](/gateway/remote) · [Tailscale](/gateway/tailscale)

### Containerized deployments

If you want a hosted or containerized setup, use the platform guides:

- [Docker](/install/docker)
- [Fly](/install/fly)
- [Render](/install/render)
- [Railway](/install/railway)
- [Northflank](/install/northflank)
- [GCP VM](/install/gcp)

## Tailoring strategy (so updates don’t hurt)

If you want “100% tailored to me” _and_ easy updates, keep your customization in:

- **Config:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memories; make it a private git repo)

Bootstrap once:

```bash
openclaw setup
```

If you don’t have a global install yet, run it via `pnpm openclaw setup`.

### Secrets checklist (template)

If you’re deploying on a server, keep secrets out of your config file and version control.
Use the repo’s `secret-template.json` as a checklist and store the filled copy somewhere private.

## Credential storage map

Use this when debugging auth or deciding what to back up:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: config/env or `channels.telegram.tokenFile`
- **Discord bot token**: config/env (token file not yet supported)
- **Slack tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Model auth profiles**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Legacy OAuth import**: `~/.openclaw/credentials/oauth.json`
  More detail: [Security](/gateway/security#credential-storage-map).

## Updating (without wrecking your setup)

- Keep `~/.openclaw/workspace` and `~/.openclaw/` as “your stuff”; don’t put personal prompts/config into the `openclaw` repo.
- Updating CLI: `openclaw update` (or `npm update -g openclaw`).
- Updating Docker deployments: rebuild the image and redeploy on your host.

## Linux (systemd user service)

Linux installs use a systemd **user** service. By default, systemd stops user
services on logout/idle, which kills the Gateway. Onboarding attempts to enable
lingering for you (may prompt for sudo). If it’s still off, run:

```bash
sudo loginctl enable-linger $USER
```

For always-on or multi-user servers, consider a **system** service instead of a
user service (no lingering needed). See [Gateway runbook](/gateway) for the systemd notes.

## Related docs

- [Gateway runbook](/gateway) (flags, supervision, ports)
- [Gateway configuration](/gateway/configuration) (config schema + examples)
- [Remote access](/gateway/remote)
- [Security](/gateway/security)
- [Channels](/channels) (auth + allowlists)
