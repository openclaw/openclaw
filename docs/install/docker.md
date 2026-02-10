---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Optional Docker-based setup and onboarding for OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a containerized gateway instead of local installs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are validating the Docker flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Docker"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Docker (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docker is **optional**. Use it only if you want a containerized gateway or to validate the Docker flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Is Docker right for me?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Yes**: you want an isolated, throwaway gateway environment or to run OpenClaw on a host without local installs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No**: you’re running on your own machine and just want the fastest dev loop. Use the normal install flow instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sandboxing note**: agent sandboxing uses Docker too, but it does **not** require the full gateway to run in Docker. See [Sandboxing](/gateway/sandboxing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This guide covers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Containerized Gateway (full OpenClaw in Docker)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-session Agent Sandbox (host gateway + Docker-isolated agent tools)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sandboxing details: [Sandboxing](/gateway/sandboxing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker Desktop (or Docker Engine) + Docker Compose v2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enough disk for images + logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Containerized Gateway (Docker Compose)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Quick start (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From repo root:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./docker-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This script:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- builds the gateway image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- runs the onboarding wizard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- prints optional provider setup hints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- starts the gateway via Docker Compose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- generates a gateway token and writes it to `.env`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional env vars:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_DOCKER_APT_PACKAGES` — install extra apt packages during build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_EXTRA_MOUNTS` — add extra host bind mounts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_HOME_VOLUME` — persist `/home/node` in a named volume（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After it finishes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Open `http://127.0.0.1:18789/` in your browser.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Paste the token into the Control UI (Settings → token).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Need the URL again? Run `docker compose run --rm openclaw-cli dashboard --no-open`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It writes config/workspace on the host:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Running on a VPS? See [Hetzner (Docker VPS)](/install/hetzner).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Shell Helpers (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For easier day-to-day Docker management, install `ClawDock`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Add to your shell config (zsh):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then use `clawdock-start`, `clawdock-stop`, `clawdock-dashboard`, etc. Run `clawdock-help` for all commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [`ClawDock` Helper README](https://github.com/openclaw/openclaw/blob/main/scripts/shell-helpers/README.md) for details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Manual flow (compose)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker build -t openclaw:local -f Dockerfile .（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose run --rm openclaw-cli onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose up -d openclaw-gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: run `docker compose ...` from the repo root. If you enabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`OPENCLAW_EXTRA_MOUNTS` or `OPENCLAW_HOME_VOLUME`, the setup script writes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`docker-compose.extra.yml`; include it when running Compose elsewhere:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Control UI token + pairing (Docker)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you see “unauthorized” or “disconnected (1008): pairing required”, fetch a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fresh dashboard link and approve the browser device:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose run --rm openclaw-cli dashboard --no-open（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose run --rm openclaw-cli devices list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose run --rm openclaw-cli devices approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More detail: [Dashboard](/web/dashboard), [Devices](/cli/devices).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Extra mounts (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to mount additional host directories into the containers, set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`OPENCLAW_EXTRA_MOUNTS` before running `docker-setup.sh`. This accepts a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
comma-separated list of Docker bind mounts and applies them to both（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw-gateway` and `openclaw-cli` by generating `docker-compose.extra.yml`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./docker-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Paths must be shared with Docker Desktop on macOS/Windows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you edit `OPENCLAW_EXTRA_MOUNTS`, rerun `docker-setup.sh` to regenerate the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  extra compose file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `docker-compose.extra.yml` is generated. Don’t hand-edit it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Persist the entire container home (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want `/home/node` to persist across container recreation, set a named（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
volume via `OPENCLAW_HOME_VOLUME`. This creates a Docker volume and mounts it at（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/home/node`, while keeping the standard config/workspace bind mounts. Use a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
named volume here (not a bind path); for bind mounts, use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`OPENCLAW_EXTRA_MOUNTS`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export OPENCLAW_HOME_VOLUME="openclaw_home"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./docker-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can combine this with extra mounts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export OPENCLAW_HOME_VOLUME="openclaw_home"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./docker-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you change `OPENCLAW_HOME_VOLUME`, rerun `docker-setup.sh` to regenerate the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  extra compose file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The named volume persists until removed with `docker volume rm <name>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Install extra apt packages (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need system packages inside the image (for example, build tools or media（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
libraries), set `OPENCLAW_DOCKER_APT_PACKAGES` before running `docker-setup.sh`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This installs the packages during the image build, so they persist even if the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
container is deleted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./docker-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- This accepts a space-separated list of apt package names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you change `OPENCLAW_DOCKER_APT_PACKAGES`, rerun `docker-setup.sh` to rebuild（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the image.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Power-user / full-featured container (opt-in)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The default Docker image is **security-first** and runs as the non-root `node`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
user. This keeps the attack surface small, but it means:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- no system package installs at runtime（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- no Homebrew by default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- no bundled Chromium/Playwright browsers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want a more full-featured container, use these opt-in knobs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Persist `/home/node`** so browser downloads and tool caches survive:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export OPENCLAW_HOME_VOLUME="openclaw_home"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./docker-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Bake system deps into the image** (repeatable + persistent):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./docker-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Install Playwright browsers without `npx`** (avoids npm override conflicts):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose run --rm openclaw-cli \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  node /app/node_modules/playwright-core/cli.js install chromium（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need Playwright to install system deps, rebuild the image with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`OPENCLAW_DOCKER_APT_PACKAGES` instead of using `--with-deps` at runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Persist Playwright browser downloads**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `docker-compose.yml`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure `/home/node` persists via `OPENCLAW_HOME_VOLUME`, or mount（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `/home/node/.cache/ms-playwright` via `OPENCLAW_EXTRA_MOUNTS`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Permissions + EACCES（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The image runs as `node` (uid 1000). If you see permission errors on（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/home/node/.openclaw`, make sure your host bind mounts are owned by uid 1000.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (Linux host):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you choose to run as root for convenience, you accept the security tradeoff.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Faster rebuilds (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To speed up rebuilds, order your Dockerfile so dependency layers are cached.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This avoids re-running `pnpm install` unless lockfiles change:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```dockerfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
FROM node:22-bookworm（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install Bun (required for build scripts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN curl -fsSL https://bun.sh/install | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ENV PATH="/root/.bun/bin:${PATH}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN corepack enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WORKDIR /app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Cache dependencies unless package metadata changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
COPY ui/package.json ./ui/package.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
COPY scripts ./scripts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN pnpm install --frozen-lockfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
COPY . .（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN pnpm ui:install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN pnpm ui:build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ENV NODE_ENV=production（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CMD ["node","dist/index.js"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Channel setup (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the CLI container to configure channels, then restart the gateway if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WhatsApp (QR):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose run --rm openclaw-cli channels login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram (bot token):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Discord (bot token):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenAI Codex OAuth (headless Docker)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you pick OpenAI Codex OAuth in the wizard, it opens a browser URL and tries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to capture a callback on `http://127.0.0.1:1455/auth/callback`. In Docker or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
headless setups that callback can show a browser error. Copy the full redirect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
URL you land on and paste it back into the wizard to finish auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Health check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### E2E smoke test (Docker)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/e2e/onboard-docker.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### QR import smoke test (Docker)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm test:docker:qr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway bind defaults to `lan` for container use.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Dockerfile CMD uses `--allow-unconfigured`; mounted config with `gateway.mode` not `local` will still start. Override CMD to enforce the guard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The gateway container is the source of truth for sessions (`~/.openclaw/agents/<agentId>/sessions/`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent Sandbox (host gateway + Docker tools)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Deep dive: [Sandboxing](/gateway/sandboxing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What it does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `agents.defaults.sandbox` is enabled, **non-main sessions** run tools inside a Docker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
container. The gateway stays on your host, but the tool execution is isolated:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- scope: `"agent"` by default (one container + workspace per agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- scope: `"session"` for per-session isolation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- per-scope workspace folder mounted at `/workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- optional agent workspace access (`agents.defaults.sandbox.workspaceAccess`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- allow/deny tool policy (deny wins)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- inbound media is copied into the active sandbox workspace (`media/inbound/*`) so tools can read it (with `workspaceAccess: "rw"`, this lands in the agent workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Warning: `scope: "shared"` disables cross-session isolation. All sessions share（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
one container and one workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Per-agent sandbox profiles (multi-agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you use multi-agent routing, each agent can override sandbox + tool settings:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.list[].sandbox` and `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools`). This lets you run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mixed access levels in one gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full access (personal agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Read-only tools + read-only workspace (family/work agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No filesystem/shell tools (public agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for examples,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
precedence, and troubleshooting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Default behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Image: `openclaw-sandbox:bookworm-slim`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- One container per agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent workspace access: `workspaceAccess: "none"` (default) uses `~/.openclaw/sandboxes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"ro"` keeps the sandbox workspace at `/workspace` and mounts the agent workspace read-only at `/agent` (disables `write`/`edit`/`apply_patch`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"rw"` mounts the agent workspace read/write at `/workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-prune: idle > 24h OR age > 7d（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Network: `none` by default (explicitly opt-in if you need egress)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default allow: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default deny: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Enable sandboxing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you plan to install packages in `setupCommand`, note:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default `docker.network` is `"none"` (no egress).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `readOnlyRoot: true` blocks package installs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `user` must be root for `apt-get` (omit `user` or set `user: "0:0"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  OpenClaw auto-recreates containers when `setupCommand` (or docker config) changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  unless the container was **recently used** (within ~5 minutes). Hot containers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  log a warning with the exact `openclaw sandbox recreate ...` command.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        mode: "non-main", // off | non-main | all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        scope: "agent", // session | agent | shared (agent is default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspaceAccess: "none", // none | ro | rw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspaceRoot: "~/.openclaw/sandboxes",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        docker: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          image: "openclaw-sandbox:bookworm-slim",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          workdir: "/workspace",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          readOnlyRoot: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          tmpfs: ["/tmp", "/var/tmp", "/run"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          network: "none",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          user: "1000:1000",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          capDrop: ["ALL"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          env: { LANG: "C.UTF-8" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          setupCommand: "apt-get update && apt-get install -y git curl jq",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          pidsLimit: 256,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          memory: "1g",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          memorySwap: "2g",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          cpus: 1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ulimits: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            nofile: { soft: 1024, hard: 2048 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            nproc: 256,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          seccompProfile: "/path/to/seccomp.json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          apparmorProfile: "openclaw-sandbox",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          dns: ["1.1.1.1", "8.8.8.8"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          extraHosts: ["internal.service:10.0.0.5"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        prune: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          idleHours: 24, // 0 disables idle pruning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          maxAgeDays: 7, // 0 disables max-age pruning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allow: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "exec",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "process",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "write",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "edit",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "sessions_list",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "sessions_history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "sessions_send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "sessions_spawn",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "session_status",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hardening knobs live under `agents.defaults.sandbox.docker`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-agent: override `agents.defaults.sandbox.{docker,browser,prune}.*` per agent via `agents.list[].sandbox.{docker,browser,prune}.*`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(ignored when `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` is `"shared"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Build the default sandbox image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/sandbox-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This builds `openclaw-sandbox:bookworm-slim` using `Dockerfile.sandbox`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sandbox common image (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want a sandbox image with common build tooling (Node, Go, Rust, etc.), build the common image:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/sandbox-common-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This builds `openclaw-sandbox-common:bookworm-slim`. To use it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sandbox browser image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To run the browser tool inside the sandbox, build the browser image:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/sandbox-browser-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This builds `openclaw-sandbox-browser:bookworm-slim` using（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`Dockerfile.sandbox-browser`. The container runs Chromium with CDP enabled and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
an optional noVNC observer (headful via Xvfb).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Headful (Xvfb) reduces bot blocking vs headless.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Headless can still be used by setting `agents.defaults.sandbox.browser.headless=true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No full desktop environment (GNOME) is needed; Xvfb provides the display.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        browser: { enabled: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Custom browser image:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: { browser: { image: "my-openclaw-browser" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When enabled, the agent receives:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- a sandbox browser control URL (for the `browser` tool)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- a noVNC URL (if enabled and headless=false)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remember: if you use an allowlist for tools, add `browser` (and remove it from（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
deny) or the tool remains blocked.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prune rules (`agents.defaults.sandbox.prune`) apply to browser containers too.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Custom sandbox image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Build your own image and point config to it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: { docker: { image: "my-openclaw-sbx" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tool policy (allow/deny)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deny` wins over `allow`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `allow` is empty: all tools (except deny) are available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `allow` is non-empty: only tools in `allow` are available (minus deny).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Pruning strategy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two knobs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `prune.idleHours`: remove containers not used in X hours (0 = disable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `prune.maxAgeDays`: remove containers older than X days (0 = disable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep busy sessions but cap lifetime:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `idleHours: 24`, `maxAgeDays: 7`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never prune:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `idleHours: 0`, `maxAgeDays: 0`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Security notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hard wall only applies to **tools** (exec/read/write/edit/apply_patch).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Host-only tools like browser/camera/canvas are blocked by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Allowing `browser` in sandbox **breaks isolation** (browser runs on host).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Image missing: build with [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) or set `agents.defaults.sandbox.docker.image`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Container not running: it will auto-create per session on demand.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Permission errors in sandbox: set `docker.user` to a UID:GID that matches your（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  mounted workspace ownership (or chown the workspace folder).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Custom tools not found: OpenClaw runs commands with `sh -lc` (login shell), which（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sources `/etc/profile` and may reset PATH. Set `docker.env.PATH` to prepend your（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  custom tool paths (e.g., `/custom/bin:/usr/local/share/npm-global/bin`), or add（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  a script under `/etc/profile.d/` in your Dockerfile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
