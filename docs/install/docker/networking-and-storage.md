---
summary: "Bind modes, reaching host providers, the Claude CLI backend, Bonjour, and what persists"
read_when:
  - The container cannot reach a provider running on your host
  - You are deciding what to mount and back up
  - You want the Claude CLI backend inside the container
title: "Docker networking, providers, and storage"
sidebarTitle: "Networking and storage"
---

Bind modes, host-provider URLs, the Claude CLI backend, Bonjour/mDNS, and mounted state. Part of the [Docker](/install/docker) guide.

## LAN vs loopback

`scripts/docker/setup.sh` defaults `OPENCLAW_GATEWAY_BIND=lan` so `http://127.0.0.1:18789` on the host works with Docker port publishing.

- `lan` (default): host browser and host CLI can reach the published gateway port.
- `loopback`: only processes inside the container network namespace can reach the gateway directly.

<Note>
Use bind mode values in `gateway.bind` (`lan` / `loopback` / `custom` / `tailnet` / `auto`), not host aliases like `0.0.0.0` or `127.0.0.1`.
</Note>

## Host local providers

Inside the container, `127.0.0.1` is the container itself, not the host. Use `host.docker.internal` for providers running on the host:

| Provider  | Host default URL         | Docker setup URL                    |
| --------- | ------------------------ | ----------------------------------- |
| LM Studio | `http://127.0.0.1:1234`  | `http://host.docker.internal:1234`  |
| Ollama    | `http://127.0.0.1:11434` | `http://host.docker.internal:11434` |

The bundled setup uses those URLs as LM Studio/Ollama onboarding defaults, and `docker-compose.yml` maps `host.docker.internal` to the host gateway on Linux Docker Engine (Docker Desktop provides the same alias on macOS/Windows). Host services must listen on an address Docker can reach:

```bash
lms server start --port 1234 --bind 0.0.0.0
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

Using your own Compose file or `docker run`? Add the same mapping yourself, e.g. `--add-host=host.docker.internal:host-gateway`.

## Claude CLI backend in Docker

The official image does not pre-install Claude Code. Install and log in inside the container's `node` user, then persist that container home so image upgrades don't erase the binary or auth state.

For a new install, enable a persistent `/home/node` volume before running setup:

```bash
export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
export OPENCLAW_HOME_VOLUME="openclaw_home"
./scripts/docker/setup.sh
```

For an existing install, stop the stack and reload the current `.env` values first — the setup script always rewrites `.env` from the current shell and defaults, it doesn't read the file on its own:

```bash
set -a
. ./.env
set +a
export OPENCLAW_HOME_VOLUME="${OPENCLAW_HOME_VOLUME:-openclaw_home}"
./scripts/docker/setup.sh
```

If `.env` contains values your shell can't source, re-export what you rely on manually first (`OPENCLAW_IMAGE`, ports, bind mode, custom paths, `OPENCLAW_EXTRA_MOUNTS`, sandbox, skip-onboarding). The generated overlay mounts the home volume for both `openclaw-gateway` and `openclaw-cli`; run the remaining commands with that overlay (and `docker-compose.override.yml` first, if you use one):

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml run --rm \
  --entrypoint sh openclaw-cli -lc \
  'curl -fsSL https://claude.ai/install.sh | bash'
```

The native installer writes `claude` to `/home/node/.local/bin/claude`. The
OpenClaw image includes `/home/node/.local/bin` on `PATH`, so the bundled
Anthropic plugin resolves it without an adapter config override.

Log in and verify from the same persisted home:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml run --rm \
  --entrypoint /home/node/.local/bin/claude openclaw-cli auth login
docker compose -f docker-compose.yml -f docker-compose.extra.yml run --rm \
  --entrypoint /home/node/.local/bin/claude openclaw-cli auth status --text
docker compose -f docker-compose.yml -f docker-compose.extra.yml run --rm \
  openclaw-cli models auth login \
  --provider anthropic --method cli --set-default
docker compose -f docker-compose.yml -f docker-compose.extra.yml run --rm \
  openclaw-cli models list --provider anthropic
```

Then use the bundled `claude-cli` backend:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml run --rm \
  openclaw-cli agent \
  --agent main \
  --model claude-cli/claude-sonnet-4-6 \
  --message "Say hello from Docker Claude CLI"
```

`OPENCLAW_HOME_VOLUME` persists the native install under `/home/node/.local/bin` and `/home/node/.local/share/claude`, plus Claude Code settings/auth under `/home/node/.claude` and `/home/node/.claude.json`. Persisting only `/home/node/.openclaw` is not enough; if you use `OPENCLAW_EXTRA_MOUNTS` instead of a home volume, mount all of those Claude paths into both services.

<Note>
For shared production automation or predictable Anthropic billing, prefer the Anthropic API-key path. Claude CLI reuse follows Claude Code's installed version, account login, billing, and update behavior.
</Note>

## Bonjour / mDNS

Docker bridge networking usually doesn't forward Bonjour/mDNS multicast (`224.0.0.251:5353`) reliably. When `OPENCLAW_DISABLE_BONJOUR` is unset, the bundled Bonjour plugin auto-disables LAN advertising once it detects it's running in a container, so it won't crash-loop retrying multicast the bridge drops. Set `OPENCLAW_DISABLE_BONJOUR=1` to force it off regardless of detection, or `0` to force it on (only on host networking, macvlan, or another network where mDNS multicast is known to work).

Use the published Gateway URL, Tailscale, or wide-area DNS-SD for Docker hosts otherwise. See [Bonjour discovery](/gateway/bonjour) for gotchas and troubleshooting.

## Storage and persistence

Docker Compose bind-mounts `OPENCLAW_CONFIG_DIR` to `/home/node/.openclaw`, `OPENCLAW_WORKSPACE_DIR` to `/home/node/.openclaw/workspace`, and `OPENCLAW_AUTH_PROFILE_SECRET_DIR` to `/home/node/.config/openclaw`, so those paths survive container replacement. When a variable is unset, `docker-compose.yml` falls back under `${HOME}`, or `/tmp` if `HOME` itself is missing, so `docker compose up` never emits an empty-source volume spec on bare environments.

That mounted config directory holds:

- `openclaw.json` for behavior config
- `state/openclaw.sqlite` for shared provider auth and `agents/<agentId>/agent/openclaw-agent.sqlite` for agent-local OAuth/API-key profiles
- `.env` for env-backed runtime secrets such as `OPENCLAW_GATEWAY_TOKEN`

The auth-profile secret directory stores the local encryption key used to recover legacy encrypted OAuth sidecar credentials. Keep it with your Docker host state, but separate from `OPENCLAW_CONFIG_DIR`.

Current OAuth token material is stored as plaintext in SQLite under `OPENCLAW_CONFIG_DIR`, including access, refresh, and ID-token values. The separate key mount does not encrypt current SQLite rows or protect these tokens from a state-only backup or copy. Treat the config directory and its backups as credentials.

Installed downloadable plugins store package state under the mounted OpenClaw home, so install records and package roots survive container replacement; gateway startup does not regenerate bundled-plugin dependency trees.

For full VM persistence details, see [Docker VM Runtime - What persists where](/install/docker-vm-runtime#what-persists-where).

**Disk growth hotspots:** `media/`, per-agent SQLite databases, legacy session JSONL transcripts, the shared SQLite state database, installed plugin package roots, and rolling file logs under `/tmp/openclaw/`.
