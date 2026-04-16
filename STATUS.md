# OpenClaw — Dev Status

> Claude and Codex read this at session start and update it at session end.
> Repo-root `STATUS.md` is the only live source of truth. Do not use the legacy copy at `/Users/liranperetz/Claw_01_on_Hetzner_server/STATUS.md` unless explicitly asked.

---

## Last Session

- **Date**: 2026-04-16 (CI runner fix)
- **What changed**:
  - **CI fix**: replaced Blacksmith third-party runners (`blacksmith-16vcpu-*`) with GitHub-hosted runners (`ubuntu-24.04`, `windows-latest`) across all 8 workflow files — Blacksmith integration was broken, leaving every workflow stuck in `queued` for 23+ hours
  - arm64 Docker build now uses QEMU emulation via `docker/setup-qemu-action` instead of a native arm runner
  - Added memory rule: always ask before integrating third-party CI/CD services
  - (prior in this session) Fixed Telegram group access, added `latest` GHCR tags, `deploy.sh` image-overwrite warning
- **Sync state**: re-check `STATUS.md` before creating a branch; one branch = one owner

---

## Currently In Progress

- Dashboard PR #53: `fix/control-deploy-infra` — awaiting merge (control/logs/deploy fixes)

---

## Next Up

1. Take control of the AgentGlob repo

> Full roadmap → [ROADMAP.md](ROADMAP.md)

---

## Blockers / Open Questions

- Gateway: Venice model discovery still times out during startup and falls back to the static catalog
- CI: arm64 Docker builds now use QEMU emulation (slower than native) — if build times are a problem, consider GitHub's `ubuntu-24.04-arm` runner (requires Team/Enterprise plan)
- Coordination: confirm ownership before touching any branch or file area the other agent is actively editing
- Branch hygiene: `chore/staging-deploy-gcp` is still listed as open and stale; verify before reuse or cleanup

---

## Active Branches / PRs

| Repo               | Branch                          | PR  | Status          | Owner   | Files / Areas Touched                    | Validation         | Next Concrete Step                       | Notes                                                                    |
| ------------------ | ------------------------------- | --- | --------------- | ------- | ---------------------------------------- | ------------------ | ---------------------------------------- | ------------------------------------------------------------------------ |
| openclaw-dashboard | codex/feat-widget-chat-v1       | #52 | merged+deployed | Codex   | Widget Chat V1 (widget tab, chat API/UI) | npm run build + CI | Monitor production behavior              | Merged to main; Cloud Run deploy run 24422489602 succeeded               |
| openclaw-dashboard | codex/fix-port-allocation-drift | #55 | merged+deployed | Codex   | agent creation, port allocation          | npm run build + CI | Monitor new-agent deploy behavior        | skips ports already claimed in live server state before allocation       |
| openclaw-dashboard | codex/fix-deploy-port-repair    | #56 | merged+deployed | Codex   | deploy route, port reservation repair    | npm run build + CI | Monitor first-deploy conflict recovery   | auto-repairs stale reserved ports for never-deployed agents              |
| openclaw-dashboard | feat/ci-cd-pipeline             | #51 | merged          | Claude  | GitHub Actions, Cloud Run pipeline       | merged             | None                                     | CI/CD auto-deploy live                                                   |
| openclaw           | fix/deploy-and-control-infra    | #7  | merged          | Claude  | docker-compose.yml                       | n/a                | None                                     | Adds OPENCLAW_SKIP_BROWSER_CONTROL_SERVER env passthrough; merged Apr 15 |
| openclaw-dashboard | fix/control-deploy-infra        | #53 | review          | Claude  | control, logs, deploy routes             | build pass         | Merge to main (auto-deploys)             | Fixes restart/logs/deploy for agents with missing containers             |
| unknown            | chore/staging-deploy-gcp        | #1  | open, stale     | unknown | GCP deploy workflow                      | unknown            | Verify ownership before reuse or cleanup | Treat as active until verified                                           |

---

## Validation Commands

- Gateway: `cd /root/projects/openclaw && pnpm install && pnpm build && pnpm test && pnpm check`
- Dashboard: `cd /root/projects/openclaw-dashboard && npm run build`

---

## Deploy Rules

- Dashboard: normal path is merge to `main`; no routine manual deploys
- Gateway/runtime: run from DevAgents with `/opt/openclaw-ops/scripts/build-and-push.sh <tag>` then `/opt/openclaw-ops/scripts/deploy.sh <tag>`
- `deploy.sh` warns when overwriting a running agent's image with a different tag — review the warning before confirming

---

## Quick Reminders

- **DevAgents**: `204.168.223.245` — dev server (repos, builds, deploy orchestration)
- EU prod (1stClaw): `89.167.70.46` — 12 agents
- US standby (2ndClaw): `5.161.84.219` — 4 agents
- Gateway repo on DevAgents: `/root/projects/openclaw`
- Dashboard repo on DevAgents: `/root/projects/openclaw-dashboard`
- Dashboard prod URL: `https://app.agentglob.com`
- Always resolve agent server from Firestore before SSH/RPC — never hardcode EU
- Always use `getAllDashboardOrigins()` not `getDashboardOrigin()` for allowedOrigins
- Canonical terms: Agent = full deployment, Bot = channel inside Agent, Org = dashboard unit, Workspace = per-Agent local dir on Hetzner
