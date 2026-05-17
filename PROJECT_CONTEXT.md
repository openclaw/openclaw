# Project context

This file is the short collaborator handoff for this repository. Keep it current
when the source setup, container workflow, or contributor routing changes.

## What this repo is

OpenClaw is a personal AI assistant and multi-channel gateway. The repo owns the
TypeScript gateway and CLI, bundled plugins, Control UI, companion app source,
public docs, Docker runtime, and the test and release harnesses around those
surfaces.

## Current state

- Default branch: `main` on `openclaw/openclaw`.
- Runtime: Node 24 is recommended. Node 22.16+ remains supported.
- Package manager: `pnpm`, pinned by `package.json` through Corepack.
- Local source loop: `pnpm install`, `pnpm openclaw setup`, then
  `pnpm gateway:watch`.
- Production container path: root `Dockerfile` plus `docker-compose.yml`;
  normal gateway startup runs the `openclaw-gateway` container.
- Source container path: one `openclaw-dev` service in
  `docker-compose.dev.yml`, backed by `Dockerfile.dev` and
  `.devcontainer/devcontainer.json`.
- Public docs live under `docs/`. Run `pnpm docs:list` before docs work and
  read only the relevant pages.

## Collaborator entry points

- `README.md`: product overview, install paths, and source setup.
- `CONTRIBUTING.md`: contribution rules, maintainer routing, PR proof rules.
- `AGENTS.md`: repo policy for AI agents and maintainers. Read scoped
  `AGENTS.md` files before editing a subtree.
- `docs/start/setup.md`: advanced source setup, including the dev container.
- `docs/install/docker.md`: production Docker gateway setup.
- `docs/plan/2026-05-17-collaborator-readiness.md`: current collaborator
  readiness spec, plan, and remaining decisions.

## Container workflows

For source development inside Docker:

```bash
docker compose -f docker-compose.dev.yml build
docker compose -f docker-compose.dev.yml run --rm openclaw-dev scripts/docker/dev-setup.sh
docker compose -f docker-compose.dev.yml run --rm --service-ports openclaw-dev pnpm gateway:watch:raw
docker compose -f docker-compose.dev.yml run --rm openclaw-dev scripts/docker/dev-token.sh
```

For a production-shaped gateway image:

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose up -d openclaw-gateway
```

Use `Dockerfile.dev` for collaborator source work. Use the root `Dockerfile` for
deployable images and release-path Docker validation.

The source development stack is intentionally single-container. It has no
database, queue, cache, or helper service sidecars. The setup script installs
dependencies and persists the local `gateway.mode`, `gateway.bind`, `gateway.port`,
token auth, and Gateway/Control UI origin settings required by the
container-published Gateway and Vite ports. The token helper prints the explicit
local dev token only when a collaborator asks for it.

## Agent operating context

- Reply with repo-root file references, not absolute paths.
- Keep core plugin-agnostic. Plugin-specific behavior belongs in the owning
  plugin.
- Use repo wrappers for tests, formatting, and checks. In Codex worktrees, avoid
  broad local `pnpm test*` or `pnpm check*`; use the documented node wrappers or
  Testbox proof for broad gates.
- Do not commit secrets. Local state belongs in `.local/`, `.env`, or
  `~/.openclaw/`, all outside committed source.
- Product docs and UI call them "plugins"; `extensions/` is the internal source
  layout.

## Open decisions

- Production hosting target is not selected here. The existing Docker image is
  suitable for VM and container hosts, but platform-specific hardening still
  belongs in the chosen deploy guide.
- The dev container gives collaborators a consistent Linux source environment.
  It does not replace release Docker proof or full cross-platform validation.
