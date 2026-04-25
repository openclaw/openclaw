---
summary: "Shared Docker VM runtime steps for long-lived OpenClaw Gateway hosts"
read_when:
  - You are deploying OpenClaw on a cloud VM with Docker
  - You need the shared binary bake, persistence, and update flow
title: "Docker VM runtime"
---

Shared runtime steps for VM-based Docker installs such as GCP, Hetzner, and similar VPS providers.

## Bake required binaries into the image

Installing binaries inside a running container is a trap.
Anything installed at runtime will be lost on restart.

All external binaries required by skills must be installed at image build time.

The examples below show two common binaries:

- `gog` for Gmail access (from the `gogcli` repo)
- `goplaces` for Google Places

These are examples, not a complete list.
You may install as many binaries as needed using the same pattern.

`wacli` (WhatsApp) is intentionally not shown here: as of v0.6.0 it ships only a macOS universal build, so it cannot run inside a Linux container. Check the [release page](https://github.com/steipete/wacli/releases) for Linux availability before adding it.

If you add new skills later that depend on additional binaries, you must:

1. Update the Dockerfile
2. Rebuild the image
3. Restart the containers

**Example Dockerfile**

```dockerfile
FROM node:24-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Pin versions for reproducible builds. Bump these as new releases ship.
ARG GOGCLI_VERSION=0.13.0
ARG GOPLACES_VERSION=0.3.0

# Example binary 1: Gmail CLI (https://github.com/steipete/gogcli/releases)
RUN curl -L "https://github.com/steipete/gogcli/releases/download/v${GOGCLI_VERSION}/gogcli_${GOGCLI_VERSION}_linux_amd64.tar.gz" \
  | tar -xz -C /usr/local/bin gog && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI (https://github.com/steipete/goplaces/releases)
RUN curl -L "https://github.com/steipete/goplaces/releases/download/v${GOPLACES_VERSION}/goplaces_${GOPLACES_VERSION}_linux_amd64.tar.gz" \
  | tar -xz -C /usr/local/bin goplaces && chmod +x /usr/local/bin/goplaces

# Add more binaries below using the same pattern

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

<Note>
The download URLs above are for x86_64 (amd64). For ARM-based VMs (e.g. Hetzner ARM, GCP Tau T2A), replace `linux_amd64` with `linux_arm64` in each URL.
</Note>

## Build and launch

```bash
docker compose build
docker compose up -d openclaw-gateway
```

If build fails with `Killed` or `exit code 137` during `pnpm install --frozen-lockfile`, the VM is out of memory.
Use a larger machine class before retrying.

Verify binaries:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
```

Expected output:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
```

Verify Gateway:

```bash
docker compose logs -f openclaw-gateway
```

Expected output:

```
[gateway] listening on ws://0.0.0.0:18789
```

## What persists where

OpenClaw runs in Docker, but Docker is not the source of truth.
All long-lived state must survive restarts, rebuilds, and reboots.

| Component           | Location                          | Persistence mechanism  | Notes                                                         |
| ------------------- | --------------------------------- | ---------------------- | ------------------------------------------------------------- |
| Gateway config      | `/home/node/.openclaw/`           | Host volume mount      | Includes `openclaw.json`, `.env`                              |
| Model auth profiles | `/home/node/.openclaw/agents/`    | Host volume mount      | `agents/<agentId>/agent/auth-profiles.json` (OAuth, API keys) |
| Skill configs       | `/home/node/.openclaw/skills/`    | Host volume mount      | Skill-level state                                             |
| Agent workspace     | `/home/node/.openclaw/workspace/` | Host volume mount      | Code and agent artifacts                                      |
| WhatsApp session    | `/home/node/.openclaw/`           | Host volume mount      | Preserves QR login                                            |
| Gmail keyring       | `/home/node/.openclaw/`           | Host volume + password | Requires `GOG_KEYRING_PASSWORD`                               |
| External binaries   | `/usr/local/bin/`                 | Docker image           | Must be baked at build time                                   |
| Node runtime        | Container filesystem              | Docker image           | Rebuilt every image build                                     |
| OS packages         | Container filesystem              | Docker image           | Do not install at runtime                                     |
| Docker container    | Ephemeral                         | Restartable            | Safe to destroy                                               |

## Updates

To update OpenClaw on the VM:

```bash
git pull
docker compose build
docker compose up -d
```

## Related

- [Docker](/install/docker)
- [Podman](/install/podman)
- [ClawDock](/install/clawdock)
