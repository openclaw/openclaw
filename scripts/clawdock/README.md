# ClawDock <!-- omit in toc -->

Stop typing `docker-compose` commands. Just type `clawdock-start`.

Inspired by Simon Willison's [Running OpenClaw in Docker](https://til.simonwillison.net/llms/openclaw-docker).

- [Quickstart](#quickstart)
- [Available Commands](#available-commands)
  - [Basic Docker Operations](#basic-docker-operations)
  - [Container Access](#container-access)
  - [Web UI \& Devices](#web-ui--devices)
  - [Setup \& Configuration](#setup--configuration)
  - [Maintenance](#maintenance)
- [Configuration \& Secrets](#configuration--secrets)
  - [Docker Files](#docker-files)
  - [Config Files](#config-files)
  - [Initial Setup](#initial-setup)
  - [How It Works in Docker](#how-it-works-in-docker)
  - [Env Precedence](#env-precedence)
  - [Data \& Backups](#data--backups)
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
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawdock/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
```

```bash
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

**See what you get:**

```bash
clawdock-help
```

On first command, ClawDock auto-detects your OpenClaw directory:

- Checks common paths (`~/openclaw`, `~/workspace/openclaw`, etc.)
- If found, asks you to confirm
- Saves to `~/.clawdock/config`

**First time setup:**

```bash
clawdock-start
```

```bash
clawdock-fix-token
```

```bash
clawdock-dashboard
```

If you see "pairing required":

```bash
clawdock-devices
```

And approve the request for the specific device:

```bash
clawdock-approve <request-id>
```

## Available Commands

### Basic Docker Operations

| Command            | Description                          |
| ------------------ | ------------------------------------ |
| `clawdock-start`   | Start the docker container           |
| `clawdock-stop`    | Stop the docker container            |
| `clawdock-restart` | Restart the docker container         |
| `clawdock-status`  | Check docker container status        |
| `clawdock-logs`    | View docker container logs (follows) |
| `clawdock-health`  | Run docker container health check    |

### Container Access

| Command                   | Description                                               |
| ------------------------- | --------------------------------------------------------- |
| `clawdock-shell`          | Shell into docker container (openclaw alias ready)        |
| `clawdock-cli <command>`  | Run CLI in docker container (e.g., `clawdock-cli status`) |
| `clawdock-exec <command>` | Execute command in docker container                       |

### Web UI & Devices

| Command                 | Description                                |
| ----------------------- | ------------------------------------------ |
| `clawdock-dashboard`    | Open web UI in browser with authentication |
| `clawdock-devices`      | List device pairing requests               |
| `clawdock-approve <id>` | Approve a device pairing request           |

### Setup & Configuration

| Command              | Description                                       |
| -------------------- | ------------------------------------------------- |
| `clawdock-fix-token` | Configure gateway authentication token (run once) |
| `clawdock-token`     | Show gateway auth token                           |
| `clawdock-config`    | Show all config files (masked secrets)            |

### Maintenance

| Command            | Description                                             |
| ------------------ | ------------------------------------------------------- |
| `clawdock-update`  | Pull, rebuild, and restart docker container             |
| `clawdock-rebuild` | Rebuild Docker image only                               |
| `clawdock-clean`   | Remove all docker containers and volumes (destructive!) |

> Config files and secrets: see [Configuration & Secrets](#configuration--secrets).

## Configuration & Secrets

The Docker setup uses three config files on the host. The container never stores secrets — everything is bind-mounted from local files.

### Docker Files

| File                       | Purpose                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `Dockerfile`               | Builds the `openclaw:local` image (Node 22, pnpm, non-root `node` user)    |
| `docker-compose.yml`       | Defines `openclaw-gateway` and `openclaw-cli` services, bind-mounts, ports |
| `docker-setup.sh`          | First-time setup — builds image, creates `.env` from `.env.example`        |
| `.env.example`             | Template for `<project>/.env` with all supported vars and docs             |
| `docker-compose.extra.yml` | Optional overrides — auto-loaded by ClawDock helpers if present            |

### Config Files

| File                        | Purpose                                          | Examples                                                            |
| --------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `<project>/.env`            | **Docker infra** — image, ports, gateway token   | `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_IMAGE`, `OPENCLAW_GATEWAY_PORT` |
| `~/.openclaw/.env`          | **Secrets** — API keys and bot tokens            | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`         |
| `~/.openclaw/openclaw.json` | **Behavior config** — models, channels, policies | Model selection, WhatsApp allowlists, agent settings                |

**Do NOT** put API keys or bot tokens in `openclaw.json`. Use `~/.openclaw/.env` for all secrets.

### Initial Setup

`./docker-setup.sh` (in the project root) handles first-time Docker configuration:

- Builds the `openclaw:local` image from `Dockerfile`
- Creates `<project>/.env` from `.env.example` with a generated gateway token
- Sets up `~/.openclaw` directories if they don't exist

```bash
./docker-setup.sh
```

After setup, add your API keys:

```bash
vim ~/.openclaw/.env
```

See `.env.example` for all supported keys.

The `Dockerfile` supports two optional build args:

- `OPENCLAW_DOCKER_APT_PACKAGES` — extra apt packages to install (e.g. `ffmpeg`)
- `OPENCLAW_INSTALL_BROWSER=1` — pre-install Chromium for browser automation (adds ~300MB, but skips the 60-90s Playwright install on each container start)

### How It Works in Docker

`docker-compose.yml` bind-mounts both config and workspace from the host:

```yaml
volumes:
  - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
  - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
```

This means:

- `~/.openclaw/.env` is available inside the container at `/home/node/.openclaw/.env` — OpenClaw loads it automatically as the global env fallback
- `~/.openclaw/openclaw.json` is available at `/home/node/.openclaw/openclaw.json` — the gateway watches it and hot-reloads most changes
- No need to add API keys to `docker-compose.yml` or configure anything inside the container
- Keys survive `clawdock-update`, `clawdock-rebuild`, and `clawdock-clean` because they live on the host

The project `.env` feeds Docker Compose directly (gateway token, image name, ports). The `~/.openclaw/.env` feeds the OpenClaw process inside the container.

### Example `~/.openclaw/.env`

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABCDEF...
```

### Example `<project>/.env`

```bash
OPENCLAW_CONFIG_DIR=/Users/you/.openclaw
OPENCLAW_WORKSPACE_DIR=/Users/you/.openclaw/workspace
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_TOKEN=<generated-by-docker-setup>
OPENCLAW_IMAGE=openclaw:local
```

### Env Precedence

OpenClaw loads env vars in this order (highest wins, never overrides existing):

1. **Process environment** — `docker-compose.yml` `environment:` block (gateway token, session keys)
2. **`.env` in CWD** — project root `.env` (Docker infra vars)
3. **`~/.openclaw/.env`** — global secrets (API keys, bot tokens)
4. **`openclaw.json` `env` block** — inline vars, applied only if still missing
5. **Shell env import** — optional login-shell scrape (`OPENCLAW_LOAD_SHELL_ENV=1`)

### Data & Backups

The container is stateless — all user data lives on the host via bind-mounts.

| Location                                    | Survives container removal? | Contents                 |
| ------------------------------------------- | --------------------------- | ------------------------ |
| `~/.openclaw/agents/*/sessions/`            | Yes (host)                  | Conversation history     |
| `~/.openclaw/workspace/memory/`             | Yes (host)                  | Daily logs + `MEMORY.md` |
| `~/.openclaw/openclaw.json`                 | Yes (host)                  | Behavior config          |
| `~/.openclaw/credentials/`                  | Yes (host)                  | API keys & tokens        |
| `~/.openclaw/.env`                          | Yes (host)                  | Secrets env file         |
| `node_modules`, Playwright browsers, `/tmp` | No (container)              | Rebuilt on start         |

`clawdock-clean` removes the container and volumes but **never touches `~/.openclaw/`**.

**Migrate to another machine:**

```bash
scp -r ~/.openclaw/ user@new-host:~/.openclaw/
```

## Common Workflows

### Update OpenClaw

> **Important:** `openclaw update` does not work inside Docker.
> The container runs as a non-root user with a source-built image, so `npm i -g` fails with EACCES.
> Use `clawdock-update` instead — it pulls, rebuilds, and restarts from the host.

```bash
clawdock-update
```

This runs `git pull` → `docker compose build` → `docker compose down/up` in one step.

If you only want to rebuild without pulling:

```bash
clawdock-rebuild && clawdock-stop && clawdock-start
```

### Check Status and Logs

**Restart the gateway:**

```bash
clawdock-restart
```

**Check container status:**

```bash
clawdock-status
```

**View live logs:**

```bash
clawdock-logs
```

### Set Up WhatsApp Bot

**Shell into the container:**

```bash
clawdock-shell
```

**Inside the container, login to WhatsApp:**

```bash
openclaw channels login --channel whatsapp --verbose
```

Scan the QR code with WhatsApp on your phone.

**Verify connection:**

```bash
openclaw status
```

### Troubleshooting Device Pairing

**Check for pending pairing requests:**

```bash
clawdock-devices
```

**Copy the Request ID from the "Pending" table, then approve:**

```bash
clawdock-approve <request-id>
```

Then refresh your browser.

### Fix Token Mismatch Issues

If you see "gateway token mismatch" errors:

```bash
clawdock-fix-token
```

This will:

1. Read the token from your `.env` file
2. Configure it in the OpenClaw config
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
- OpenClaw project cloned and initialized with `./docker-setup.sh`

## Development

**Test with fresh config (mimics first-time install):**

```bash
unset CLAWDOCK_DIR && rm -f ~/.clawdock/config && source scripts/clawdock/clawdock-helpers.sh
```

Then run any command to trigger auto-detect:

```bash
clawdock-start
```
