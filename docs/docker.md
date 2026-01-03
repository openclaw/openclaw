---
summary: "Optional Docker-based setup and onboarding for Clawdis"
read_when:
  - You want a containerized gateway instead of local installs
  - You are validating the Docker flow
---

# Docker (optional)

Docker is **optional**. Use it only if you want a containerized gateway or to validate the Docker flow.

This guide covers:
- Containerized Gateway (full Clawdis in Docker)
- Per-session Agent Sandbox (host gateway + Docker-isolated agent tools)

## Requirements

- Docker Desktop (or Docker Engine) + Docker Compose v2
- Enough disk for images + logs

## Containerized Gateway (Docker Compose)

### Quick start (recommended)

From repo root:

```bash
./docker-setup.sh
```

This script:
- builds the gateway image
- runs the onboarding wizard
- runs WhatsApp login
- starts the gateway via Docker Compose

It writes config/workspace on the host:
- `~/.clawdis/`
- `~/clawd`

### Manual flow (compose)

```bash
docker build -t clawdis:local -f Dockerfile .
docker compose run --rm clawdis-cli onboard
docker compose run --rm clawdis-cli login
docker compose up -d clawdis-gateway
```

### Health check

```bash
docker compose exec clawdis-gateway node dist/index.js health --token "$CLAWDIS_GATEWAY_TOKEN"
```

### E2E smoke test (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### Notes

- Gateway bind defaults to `lan` for container use.
- The gateway container is the source of truth for sessions (`~/.clawdis/sessions`).

## Per-session Agent Sandbox (host gateway + Docker tools)

### What it does

When `agent.sandbox` is enabled, **non-main sessions** run tools inside a Docker
container. The gateway stays on your host, but the tool execution is isolated:
- one container per session (hard wall)
- per-session workspace folder mounted at `/workspace`
- allow/deny tool policy (deny wins)

### Default behavior

- Image: `clawdis-sandbox:bookworm-slim`
- One container per session
- Workspace per session under `~/.clawdis/sandboxes`
- Auto-prune: idle > 24h OR age > 7d
- Default allow: `bash`, `process`, `read`, `write`, `edit`
- Default deny: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### Enable sandboxing

```json5
{
  agent: {
    sandbox: {
      mode: "non-main", // off | non-main | all
      perSession: true,
      workspaceRoot: "~/.clawdis/sandboxes",
      docker: {
        image: "clawdis-sandbox:bookworm-slim",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp", "/var/tmp", "/run"],
        network: "bridge",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
        setupCommand: "apt-get update && apt-get install -y git curl jq"
      },
      tools: {
        allow: ["bash", "process", "read", "write", "edit"],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"]
      },
      prune: {
        idleHours: 24, // 0 disables idle pruning
        maxAgeDays: 7  // 0 disables max-age pruning
      }
    }
  }
}
```

### Build the default sandbox image

```bash
scripts/sandbox-setup.sh
```

This builds `clawdis-sandbox:bookworm-slim` using `Dockerfile.sandbox`.

### Custom sandbox image

Build your own image and point config to it:

```bash
docker build -t my-clawdis-sbx -f Dockerfile.sandbox .
```

```json5
{
  agent: {
    sandbox: { docker: { image: "my-clawdis-sbx" } }
  }
}
```

### Tool policy (allow/deny)

- `deny` wins over `allow`.
- If `allow` is empty: all tools (except deny) are available.
- If `allow` is non-empty: only tools in `allow` are available (minus deny).

### Pruning strategy

Two knobs:
- `prune.idleHours`: remove containers not used in X hours (0 = disable)
- `prune.maxAgeDays`: remove containers older than X days (0 = disable)

Example:
- Keep busy sessions but cap lifetime:
  `idleHours: 24`, `maxAgeDays: 7`
- Never prune:
  `idleHours: 0`, `maxAgeDays: 0`

### Security notes

- Hard wall only applies to **tools** (bash/read/write/edit).  
- Host-only tools like browser/camera/canvas are blocked by default.  
- Allowing `browser` in sandbox **breaks isolation** (browser runs on host).

## Troubleshooting

- Image missing: build with `scripts/sandbox-setup.sh` or set `agent.sandbox.docker.image`.
- Container not running: it will auto-create per session on demand.
- Permission errors in sandbox: set `docker.user` to a UID:GID that matches your
  mounted workspace ownership (or chown the workspace folder).
