# ClawDock <!-- omit in toc -->

Stop typing `docker-compose` commands. Just type `mullusiock-start`.

Inspired by Simon Willison's [Running Mullusi in Docker](https://til.simonwillison.net/llms/mullusi-docker).

- [Quickstart](#quickstart)
- [Available Commands](#available-commands)
  - [Basic Operations](#basic-operations)
  - [Container Access](#container-access)
  - [Web UI \& Devices](#web-ui--devices)
  - [Setup \& Configuration](#setup--configuration)
  - [Maintenance](#maintenance)
  - [Utilities](#utilities)
- [Configuration \& Secrets](#configuration--secrets)
  - [Docker Files](#docker-files)
  - [Config Files](#config-files)
  - [Initial Setup](#initial-setup)
  - [How It Works in Docker](#how-it-works-in-docker)
  - [Env Precedence](#env-precedence)
- [Common Workflows](#common-workflows)
  - [Check Status and Logs](#check-status-and-logs)
  - [Set Up WhatsApp Bot](#set-up-whatsapp-bot)
  - [Troubleshooting Device Pairing](#troubleshooting-device-pairing)
  - [Fix Token Mismatch Issues](#fix-token-mismatch-issues)
  - [Permission Denied](#permission-denied)
- [Requirements](#requirements)
- [Development](#development)

## Quickstart

**Install:**

```bash
mkdir -p ~/.mullusiock && curl -sL https://raw.githubusercontent.com/mullusi/mullusi/main/scripts/mullusiock/mullusiock-helpers.sh -o ~/.mullusiock/mullusiock-helpers.sh
```

```bash
echo 'source ~/.mullusiock/mullusiock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

Canonical docs page: https://docs.mullusi.com/install/mullusiock

If you previously installed ClawDock from `scripts/shell-helpers/mullusiock-helpers.sh`, rerun the install command above. The old raw GitHub path has been removed.

**See what you get:**

```bash
mullusiock-help
```

On first command, ClawDock auto-detects your Mullusi directory:

- Checks common paths (`~/mullusi`, `~/workspace/mullusi`, etc.)
- If found, asks you to confirm
- Saves to `~/.mullusiock/config`

**First time setup:**

```bash
mullusiock-start
```

```bash
mullusiock-fix-token
```

```bash
mullusiock-dashboard
```

If you see "pairing required":

```bash
mullusiock-devices
```

And approve the request for the specific device:

```bash
mullusiock-approve <request-id>
```

## Available Commands

### Basic Operations

| Command            | Description                     |
| ------------------ | ------------------------------- |
| `mullusiock-start`   | Start the gateway               |
| `mullusiock-stop`    | Stop the gateway                |
| `mullusiock-restart` | Restart the gateway             |
| `mullusiock-status`  | Check container status          |
| `mullusiock-logs`    | View live logs (follows output) |

### Container Access

| Command                   | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `mullusiock-shell`          | Interactive shell inside the gateway container |
| `mullusiock-cli <command>`  | Run Mullusi CLI commands                      |
| `mullusiock-exec <command>` | Execute arbitrary commands in the container    |

### Web UI & Devices

| Command                 | Description                                |
| ----------------------- | ------------------------------------------ |
| `mullusiock-dashboard`    | Open web UI in browser with authentication |
| `mullusiock-devices`      | List device pairing requests               |
| `mullusiock-approve <id>` | Approve a device pairing request           |

### Setup & Configuration

| Command              | Description                                       |
| -------------------- | ------------------------------------------------- |
| `mullusiock-fix-token` | Configure gateway authentication token (run once) |

### Maintenance

| Command            | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `mullusiock-update`  | Pull latest, rebuild image, and restart (one command) |
| `mullusiock-rebuild` | Rebuild the Docker image only                         |
| `mullusiock-clean`   | Remove all containers and volumes (destructive!)      |

### Utilities

| Command                | Description                               |
| ---------------------- | ----------------------------------------- |
| `mullusiock-health`      | Run gateway health check                  |
| `mullusiock-token`       | Display the gateway authentication token  |
| `mullusiock-cd`          | Jump to the Mullusi project directory    |
| `mullusiock-config`      | Open the Mullusi config directory        |
| `mullusiock-show-config` | Print config files with redacted values   |
| `mullusiock-workspace`   | Open the workspace directory              |
| `mullusiock-help`        | Show all available commands with examples |

## Configuration & Secrets

The Docker setup uses three config files on the host. The container never stores secrets — everything is bind-mounted from local files.

### Docker Files

| File                       | Purpose                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `Dockerfile`               | Builds the `mullusi:local` image (Node 22, pnpm, non-root `node` user)    |
| `docker-compose.yml`       | Defines `mullusi-gateway` and `mullusi-cli` services, bind-mounts, ports |
| `docker-setup.sh`          | First-time setup — builds image, creates `.env` from `.env.example`        |
| `.env.example`             | Template for `<project>/.env` with all supported vars and docs             |
| `docker-compose.extra.yml` | Optional overrides — auto-loaded by ClawDock helpers if present            |

### Config Files

| File                        | Purpose                                          | Examples                                                            |
| --------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `<project>/.env`            | **Docker infra** — image, ports, gateway token   | `MULLUSI_GATEWAY_TOKEN`, `MULLUSI_IMAGE`, `MULLUSI_GATEWAY_PORT` |
| `~/.mullusi/.env`          | **Secrets** — API keys and bot tokens            | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`         |
| `~/.mullusi/mullusi.json` | **Behavior config** — models, channels, policies | Model selection, WhatsApp allowlists, agent settings                |

**Do NOT** put API keys or bot tokens in `mullusi.json`. Use `~/.mullusi/.env` for all secrets.

### Initial Setup

`./docker-setup.sh` (in the project root) handles first-time Docker configuration:

- Builds the `mullusi:local` image from `Dockerfile`
- Creates `<project>/.env` from `.env.example` with a generated gateway token
- Sets up `~/.mullusi` directories if they don't exist

```bash
./docker-setup.sh
```

After setup, add your API keys:

```bash
vim ~/.mullusi/.env
```

See `.env.example` for all supported keys.

The `Dockerfile` supports two optional build args:

- `MULLUSI_DOCKER_APT_PACKAGES` — extra apt packages to install (e.g. `ffmpeg`)
- `MULLUSI_INSTALL_BROWSER=1` — pre-install Chromium for browser automation (adds ~300MB, but skips the 60-90s Playwright install on each container start)

### How It Works in Docker

`docker-compose.yml` bind-mounts both config and workspace from the host:

```yaml
volumes:
  - ${MULLUSI_CONFIG_DIR}:/home/node/.mullusi
  - ${MULLUSI_WORKSPACE_DIR}:/home/node/.mullusi/workspace
```

This means:

- `~/.mullusi/.env` is available inside the container at `/home/node/.mullusi/.env` — Mullusi loads it automatically as the global env fallback
- `~/.mullusi/mullusi.json` is available at `/home/node/.mullusi/mullusi.json` — the gateway watches it and hot-reloads most changes
- No need to add API keys to `docker-compose.yml` or configure anything inside the container
- Keys survive `mullusiock-update`, `mullusiock-rebuild`, and `mullusiock-clean` because they live on the host

The project `.env` feeds Docker Compose directly (gateway token, image name, ports). The `~/.mullusi/.env` feeds the Mullusi process inside the container.

### Example `~/.mullusi/.env`

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABCDEF...
```

### Example `<project>/.env`

```bash
MULLUSI_CONFIG_DIR=/Users/you/.mullusi
MULLUSI_WORKSPACE_DIR=/Users/you/.mullusi/workspace
MULLUSI_GATEWAY_PORT=18790
MULLUSI_BRIDGE_PORT=18790
MULLUSI_GATEWAY_BIND=lan
MULLUSI_GATEWAY_TOKEN=<generated-by-docker-setup>
MULLUSI_IMAGE=mullusi:local
```

### Env Precedence

Mullusi loads env vars in this order (highest wins, never overrides existing):

1. **Process environment** — `docker-compose.yml` `environment:` block (gateway token, session keys)
2. **`.env` in CWD** — project root `.env` (Docker infra vars)
3. **`~/.mullusi/.env`** — global secrets (API keys, bot tokens)
4. **`mullusi.json` `env` block** — inline vars, applied only if still missing
5. **Shell env import** — optional login-shell scrape (`MULLUSI_LOAD_SHELL_ENV=1`)

## Common Workflows

### Update Mullusi

> **Important:** `mullusi update` does not work inside Docker.
> The container runs as a non-root user with a source-built image, so `npm i -g` fails with EACCES.
> Use `mullusiock-update` instead — it pulls, rebuilds, and restarts from the host.

```bash
mullusiock-update
```

This runs `git pull` → `docker compose build` → `docker compose down/up` in one step.

If you only want to rebuild without pulling:

```bash
mullusiock-rebuild && mullusiock-stop && mullusiock-start
```

### Check Status and Logs

**Restart the gateway:**

```bash
mullusiock-restart
```

**Check container status:**

```bash
mullusiock-status
```

**View live logs:**

```bash
mullusiock-logs
```

### Set Up WhatsApp Bot

**Shell into the container:**

```bash
mullusiock-shell
```

**Inside the container, login to WhatsApp:**

```bash
mullusi channels login --channel whatsapp --verbose
```

Scan the QR code with WhatsApp on your phone.

**Verify connection:**

```bash
mullusi status
```

### Troubleshooting Device Pairing

**Check for pending pairing requests:**

```bash
mullusiock-devices
```

**Copy the Request ID from the "Pending" table, then approve:**

```bash
mullusiock-approve <request-id>
```

Then refresh your browser.

### Fix Token Mismatch Issues

If you see "gateway token mismatch" errors:

```bash
mullusiock-fix-token
```

This will:

1. Read the token from your `.env` file
2. Configure it in the Mullusi config
3. Restart the gateway
4. Verify the configuration

### Permission Denied

**Ensure Docker is running and you have permission:**

```bash
docker ps
```

## Requirements

- Docker and Docker Compose installed
- Bash or Zsh shell
- Mullusi project (run `scripts/docker/setup.sh`)

## Development

**Test with fresh config (mimics first-time install):**

```bash
unset CLAWDOCK_DIR && rm -f ~/.mullusiock/config && source scripts/mullusiock/mullusiock-helpers.sh
```

Then run any command to trigger auto-detect:

```bash
mullusiock-start
```
