---
title: "Collaborator readiness and containerized development"
summary: "Spec and plan for making the repo easier to hand to collaborators with a consistent Docker-backed source workflow"
read_when:
  - Adding collaborators to the OpenClaw repository
  - Setting up source development in a container
  - Reviewing the current Docker and contributor handoff state
---

## Status

First-pass implementation.

The repository already had a production-oriented Docker runtime through the root
`Dockerfile` and `docker-compose.yml`. This plan adds the missing collaborator
handoff layer: a concise root context file, a source-development container, and
docs that explain when to use the dev container versus the production image.

## Goal

Make the repository safe and fast to hand to new collaborators by giving them
clear context, the canonical operating rules, and a reproducible Linux source
environment.

## Non-goals

- Do not replace the production Dockerfile with a development image.
- Do not pick a production hosting provider in this pass.
- Do not move secrets, auth profiles, or local OpenClaw state into the repo.
- Do not change product behavior, plugin contracts, gateway protocol, or build
  outputs.

## Current state

- `README.md` and `CONTRIBUTING.md` explain source setup and contribution
  rules, but the repo did not have a short current-state handoff file for
  collaborators and agents.
- `AGENTS.md` is the canonical repo policy file, with scoped `AGENTS.md` files
  under docs, scripts, source, plugins, UI, and tests.
- The root `Dockerfile` is a multi-stage runtime image intended for production,
  release validation, and packaged gateway execution.
- `docker-compose.yml` runs production-shaped `openclaw-gateway` and
  `openclaw-cli` services against the built image.
- Source development still needed a lightweight container entry point that
  mounts the repo and runs `pnpm` commands in a consistent Node Linux
  environment without adding service sidecars.
- Fresh source containers needed an explicit local gateway config stamp before
  the watcher could start cleanly on a host-published port.

## Spec

The collaborator-ready repo should provide three clear paths:

1. Local source development for contributors who already have Node and pnpm.
2. Source development inside Docker for collaborators who want the same Linux
   toolchain and dependency layout.
3. Production-shaped Docker runtime for deployment and release-path validation.

The source-development container must:

- Use Node 24, matching the recommended source runtime.
- Use the repo-pinned `packageManager` through Corepack.
- Mount the checkout at `/workspace`.
- Keep container dependency caches in Docker volumes.
- Keep local OpenClaw state under the repo ignored `.local/` directory by
  default.
- Define exactly one source-development service and no sidecar containers.
- Expose only the Gateway and Vite UI ports used by the normal dev loop.
- Persist `gateway.mode=local`, `gateway.bind=lan`, `gateway.port=18789`,
  token auth, and matching Gateway and Vite Control UI origins during first-run
  setup.
- Stay separate from the production Dockerfile so deploy images remain minimal.

The documentation must:

- Point collaborators first to `PROJECT_CONTEXT.md`, `README.md`,
  `CONTRIBUTING.md`, and `AGENTS.md`.
- Explain when to use `Dockerfile.dev` versus the root `Dockerfile`.
- Keep Docker install docs focused on the deployable gateway path while linking
  source development back to setup docs.

## Implementation plan

1. Add `PROJECT_CONTEXT.md` at the repo root with the current state, entry
   points, container paths, agent rules, and open decisions.
2. Add `Dockerfile.dev` for a source-development image based on Node 24 with
   Corepack, pnpm, Git, Python, build tools, and `tini`.
3. Add `docker-compose.dev.yml` with a single `openclaw-dev` service that
   mounts the repo, persists pnpm and Node dependency volumes, maps Gateway
   ports, and defaults to a shell.
4. Add `scripts/docker/dev-setup.sh` to install dependencies, generate or reuse
   local token auth, and persist the local gateway config required by
   containerized source development.
5. Add `scripts/docker/dev-token.sh` to print the local dev token explicitly
   without making first-run setup echo secrets by default.
6. Add `.devcontainer/devcontainer.json` so VS Code and compatible tools can
   open the same Compose-backed source container.
7. Update `README.md`, `docs/start/setup.md`, and `docs/install/docker.md` to
   describe the source-development container and distinguish it from the
   production Docker path.
8. Update `.github/labeler.yml` so Docker-related dev container changes route
   to the Docker label.
9. Verify docs formatting and the container smoke path before publishing the
   branch.

## Remaining decisions

- Choose the actual production host and deployment model.
- Decide whether collaborators should use GitHub Codespaces in addition to the
  local dev container.
- Decide whether to publish a prebuilt dev image or keep building it locally
  from `Dockerfile.dev`.
- Decide which broad Docker or release-path Testbox lane should become the
  final gate before merging this branch.
