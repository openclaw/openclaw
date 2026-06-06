# Upgrading Zorg MemoryDB

Zorg MemoryDB is an additive overlay on upstream OpenClaw. Upgrades must preserve the existing OpenClaw home, workspace, credentials, sessions, PostgreSQL data, and memory database.

If terminal commands, SSH, `cd`, or folder paths are unfamiliar, read [`beginner-terminal-and-ssh.md`](beginner-terminal-and-ssh.md) before upgrading. Upgrade pages explain each command, but that page explains the basic words first.

Official OpenClaw basis:

OpenClaw updating guide: https://docs.openclaw.ai/install/updating

OpenClaw Docker guide: https://docs.openclaw.ai/install/docker

Upstream source: https://github.com/openclaw/openclaw

Official host Docker/Dockge basis:

Docker Engine on Ubuntu: https://docs.docker.com/engine/install/ubuntu/

Dockge upstream README: https://github.com/louislam/dockge

Do not use one upgrade recipe for every install. Pick the page that matches how the assistant was installed.

## What Upgrade Means

An upgrade can change two different things:

**OpenClaw itself:** the upstream OpenClaw program, updated with OpenClaw's official `openclaw update` command when the install is native.

**Zorg MemoryDB overlay:** the extra memory schema, scripts, templates, Docker image, and documentation from this repository.

Beginners should not have to decide which internal part changed. The pages below keep each install type separate and explain which part each command touches.

## Important Words

**Assistant folder:** the folder named after the assistant, such as `~/front-desk-assistant/` or `~/my-ai-assistant/`.

**State folder:** `openclaw-home/`, the folder that stores OpenClaw state and memory data for Docker-based installs.

**Docker service/container name, not the assistant name:** the running Docker service, usually named `openclaw` in Docker Compose and Dockge.

**Image:** the packaged Docker build, such as `ghcr.io/stefrush2099/zorg-memorydb:latest`.

The state folder is the part you protect. The image, scripts, and container wrapper can be replaced during an upgrade.

## Step 1: Choose Your Install Type

Use this table first:
| If you installed this way | Use this upgrade page | Beginner path used in examples | | --- | --- | --- | | Standard Ubuntu one-line installer | [Standard Ubuntu upgrade](upgrade-standard-ubuntu.md) | `~/front-desk-assistant/` | | Existing plain OpenClaw install that needs the Zorg overlay added or refreshed | [Existing OpenClaw install upgrade](upgrade-existing-openclaw.md) | `~/front-desk-assistant/` plus `$HOME/.openclaw/workspace` | | Docker Compose clone + `docker compose up` | [Docker Compose upgrade](upgrade-docker-compose.md) | `~/my-ai-assistant/` | | Dockge stack | [Dockge upgrade](upgrade-dockge.md) | `/opt/stacks/front-desk-assistant/` | | Direct `docker run` container | [Docker run upgrade](upgrade-docker-run.md) | `~/front-desk-assistant/` | | Host Docker Engine or Dockge manager container | [Host Docker/Dockge manager upgrade](upgrade-host-docker-dockge.md) | `/opt/dockge/` and `/opt/stacks/` |

## Step 2: Preserve the State Folder

The folder named `openclaw-home/` is the important data folder for Docker Compose, Dockge, and Docker run installs. It stores OpenClaw state and the embedded PostgreSQL-backed memory database.

Do not delete `openclaw-home/` during an upgrade.

For Docker Compose and Dockge installs, do not rely on a plain `docker compose up -d --build` as the upgrade command. Docker can reuse cached layers, including the layer that installed `openclaw@latest`, so the container can restart without actually receiving the current OpenClaw package. Use the matching Docker Compose or Dockge upgrade page; both force a clean image rebuild before recreating the service.

## Step 3: Run Only the Matching Page

Each upgrade page is separated so Docker Compose, Dockge, and Docker run instructions are not mixed together. Follow one page from top to bottom.

Host Docker Engine and the Dockge manager container are infrastructure upgrades, not OpenClaw/Zorg overlay upgrades. Do not use the assistant stack upgrade pages to upgrade Docker Engine or Dockge itself.

## Step 4: Verify

After the matching upgrade page is complete, verify the same surface you use to operate OpenClaw:

browser Control UI opens on the selected Gateway port

TUI opens with the documented command for that install type

database recall check returns `database-direct-vector-neural-weighted`

`openclaw doctor` or the containerized equivalent completes

## SQL-Only Rule Updates

Some releases include an additive SQL update that can be applied to an existing
MemoryDB without replacing the whole OpenClaw install. For the canonical public
rule cleanup and chat-response timing weight update, apply:

```bash
psql "$DATABASE_URL" -f db/public_canonical_rules_update_2026_06_02.sql
```

Use the equivalent container or local PostgreSQL command for your install type.
The update is public-safe and structural: it seeds sanitized rules into
`zorg_logic_rules`, verifies that all 93 expected active public rules were
seeded, disables active rows in `zorg_rules` and `zorg_rule_catalog`, and
updates existing dynamic timing weights. It does not publish or install private
database rows.

## Rollback

For Docker Compose and Dockge installs, rollback means checking out a previous Git tag and rebuilding the same stack while keeping `openclaw-home/` in place.

For Docker run installs, rollback means running a previous image tag while mounting the same `openclaw-home/` folder.

For plain upstream OpenClaw installs, use the official OpenClaw rollback guidance in the updating guide.
