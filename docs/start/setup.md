---
summary: "Advanced setup and development workflows for OpenClaw"
read_when:
  - Setting up a new machine
  - You want "latest + greatest" without breaking your personal setup
title: "Setup"
---

<Note>
If you are setting up for the first time, start with [Getting Started](/start/getting-started).
For onboarding details, see [Onboarding (CLI)](/start/wizard).
</Note>

## TL;DR

Pick a setup workflow based on how often you want updates and whether you want to run the Gateway yourself:

- **Tailoring lives outside the repo:** keep your config and workspace in `~/.openclaw/openclaw.json` and `~/.openclaw/workspace/` so repo updates don't touch them.
- **Stable workflow (recommended for most):** install the macOS app and let it run the bundled Gateway.
- **Bleeding edge workflow (dev):** run the Gateway yourself via `pnpm gateway:watch`, then let the macOS app attach in Local mode.

## Prereqs (from source)

- Node 24 recommended (Node 22 LTS, currently `22.16+`, still supported)
- `pnpm` required for source checkouts. OpenClaw loads bundled plugins from the
  `extensions/*` pnpm workspace packages in dev mode, so root `npm install` does
  not prepare the full source tree.
- Docker (optional; for source containers, containerized setup, and e2e - see [Docker](/install/docker))

## Containerized source development

Use this path when collaborators need the same Linux Node and pnpm environment
without installing the full source toolchain on the host. The dev Compose file
defines one `openclaw-dev` service and no sidecars. It is for source work only.
Use the root `Dockerfile` and `docker-compose.yml` for production-shaped gateway
images.

Build the development image:

```bash
docker compose -f docker-compose.dev.yml build
```

Install dependencies and write the local gateway config inside the container:

```bash
docker compose -f docker-compose.dev.yml run --rm openclaw-dev scripts/docker/dev-setup.sh
```

Run the Gateway in the foreground with source reload behavior:

```bash
docker compose -f docker-compose.dev.yml run --rm --service-ports openclaw-dev pnpm gateway:watch:raw
```

Run one-off repo commands the same way:

```bash
docker compose -f docker-compose.dev.yml run --rm openclaw-dev pnpm docs:list
docker compose -f docker-compose.dev.yml run --rm openclaw-dev pnpm build
```

The setup script runs `pnpm install --frozen-lockfile`, creates ignored local
state directories, persists `gateway.mode=local`, `gateway.bind=lan`, and
`gateway.port=18789`, and generates or reuses local token auth so the
container-published Gateway port is reachable from the host. It also allowlists
the Gateway and Vite Control UI origins for `localhost` and `127.0.0.1`. When
you need to paste the local Control UI token, print it explicitly:

```bash
docker compose -f docker-compose.dev.yml run --rm openclaw-dev scripts/docker/dev-token.sh
```

The Compose file mounts the checkout at `/workspace`, keeps pnpm and
`node_modules` in Docker volumes, stores OpenClaw local state under `.local/`,
and publishes ports `18789` and `5173` for Gateway and UI development. One-off
commands run against the same image and do not require a second service.

VS Code and compatible tools can open the same environment through
`.devcontainer/devcontainer.json`.

## Tailoring strategy (so updates do not hurt)

If you want "100% tailored to me" _and_ easy updates, keep your customization in:

- **Config:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memories; make it a private git repo)

Bootstrap once:

```bash
openclaw setup
```

From inside this repo, use the local CLI entry:

```bash
openclaw setup
```

If you don't have a global install yet, run it via `pnpm openclaw setup`.

## Run the Gateway from this repo

After `pnpm build`, you can run the packaged CLI directly:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Stable workflow (macOS app first)

1. Install + launch **OpenClaw.app** (menu bar).
2. Complete the onboarding/permissions checklist (TCC prompts).
3. Ensure Gateway is **Local** and running (the app manages it).
4. Link surfaces (example: WhatsApp):

```bash
openclaw channels login
```

5. Sanity check:

```bash
openclaw health
```

If onboarding is not available in your build:

- Run `openclaw setup`, then `openclaw channels login`, then start the Gateway manually (`openclaw gateway`).

## Bleeding edge workflow (Gateway in a terminal)

Goal: work on the TypeScript Gateway, get hot reload, keep the macOS app UI attached.

### 0) (Optional) Run the macOS app from source too

If you also want the macOS app on the bleeding edge:

```bash
./scripts/restart-mac.sh
```

### 1) Start the dev Gateway

```bash
pnpm install
# First run only (or after resetting local OpenClaw config/workspace)
pnpm openclaw setup
pnpm gateway:watch
```

`gateway:watch` starts or restarts the Gateway watch process in a named tmux
session and auto-attaches from interactive terminals. Non-interactive shells stay
detached and print `tmux attach -t openclaw-gateway-watch-main`; use
`OPENCLAW_GATEWAY_WATCH_ATTACH=0 pnpm gateway:watch` to keep an interactive run
detached, or `pnpm gateway:watch:raw` for foreground watch mode. The watcher
reloads on relevant source, config, and bundled-plugin metadata changes. If the
watched Gateway exits during startup, `gateway:watch` runs
`openclaw doctor --fix --non-interactive` once and retries; set
`OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR=0` to disable that dev-only repair pass.
`pnpm openclaw setup` is the one-time local config/workspace initialization step for a fresh checkout.
`pnpm gateway:watch` does not rebuild `dist/control-ui`, so rerun `pnpm ui:build` after `ui/` changes or use `pnpm ui:dev` while developing the Control UI.

### 2) Point the macOS app at your running Gateway

In **OpenClaw.app**:

- Connection Mode: **Local**
  The app will attach to the running gateway on the configured port.

### 3) Verify

- In-app Gateway status should read **"Using existing gateway …"**
- Or via CLI:

```bash
openclaw health
```

### Common footguns

- **Wrong port:** Gateway WS defaults to `ws://127.0.0.1:18789`; keep app + CLI on the same port.
- **Where state lives:**
  - Channel/provider state: `~/.openclaw/credentials/`
  - Model auth profiles: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Sessions: `~/.openclaw/agents/<agentId>/sessions/`
  - Logs: `/tmp/openclaw/`

## Credential storage map

Use this when debugging auth or deciding what to back up:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: config/env or `channels.telegram.tokenFile` (regular file only; symlinks rejected)
- **Discord bot token**: config/env or SecretRef (env/file/exec providers)
- **Slack tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**:
  - `~/.openclaw/credentials/<channel>-allowFrom.json` (default account)
  - `~/.openclaw/credentials/<channel>-<accountId>-allowFrom.json` (non-default accounts)
- **Model auth profiles**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **File-backed secrets payload (optional)**: `~/.openclaw/secrets.json`
- **Legacy OAuth import**: `~/.openclaw/credentials/oauth.json`
  More detail: [Security](/gateway/security#credential-storage-map).

## Updating (without wrecking your setup)

- Keep `~/.openclaw/workspace` and `~/.openclaw/` as "your stuff"; don't put personal prompts/config into the `openclaw` repo.
- Updating source: `git pull` + `pnpm install` + keep using `pnpm gateway:watch`.

## Linux (systemd user service)

Linux installs use a systemd **user** service. By default, systemd stops user
services on logout/idle, which kills the Gateway. Onboarding attempts to enable
lingering for you (may prompt for sudo). If it's still off, run:

```bash
sudo loginctl enable-linger $USER
```

For always-on or multi-user servers, consider a **system** service instead of a
user service (no lingering needed). See [Gateway runbook](/gateway) for the systemd notes.

## Related docs

- [Gateway runbook](/gateway) (flags, supervision, ports)
- [Gateway configuration](/gateway/configuration) (config schema + examples)
- [Discord](/channels/discord) and [Telegram](/channels/telegram) (reply tags + replyToMode settings)
- [OpenClaw assistant setup](/start/openclaw)
- [macOS app](/platforms/macos) (gateway lifecycle)
