# OpenClaw — Dev Status

> Claude and Codex read this at session start and update it at session end.
> Repo-root `STATUS.md` is the only live source of truth. Do not use the legacy copy at `/Users/liranperetz/Claw_01_on_Hetzner_server/STATUS.md` unless explicitly asked.

---

## Last Session

- **Date**: 2026-05-03 (dashboard NVIDIA public-chat hotfix)
- **What changed**:
  - **Dashboard PR #61** (`hotfix/nvidia-designer-chat`): fixed the agent config dropdown/landing-page model split, registered the requested NVIDIA models in generated `openclaw.json`, corrected NVIDIA GLM-5 runtime id to `nvidia/z-ai/glm-5.1` while displaying `GLM-5`, sent the selected landing-page model through public chat, limited public Venice choices to the requested set, and sanitized invalid `channels.defaults`/`accessMode`/`groupEnabled` fields before saving configs
  - **Gateway PR #10** (`hotfix/nvidia-compose-env`): passed `NVIDIA_API_KEY` into gateway/CLI containers and documented it in `.env.example`
  - **Runtime repair**: migrated the existing Jojo/projectmanager NVIDIA secret from legacy `NVIDIA` to `NVIDIA_API_KEY` on both prod servers, repaired `designer` config, added the NVIDIA model provider definitions, applied the compose env passthrough on EU/US, and restarted `designer`
  - **Production deploy**: CI/CD deployed Cloud Run revision `openclaw-dashboard-00237-6tr` (100% traffic) and pushed tag `v2026.5.3.2`
- **Validation**:
  - Dashboard: `npx tsc --noEmit`, `npm run build`, GitHub Actions run `25282456664`
  - Runtime: `https://app.agentglob.com/api/public/chat/designer/models` returns NVIDIA-first model list; selected-model public chat smoke test returned `deployed-ok`; login returned `HTTP/2 200`

---

## Last Session (prev)

- **Date**: 2026-05-03 (dashboard NVIDIA model defaults)
- **What changed**:
  - **Dashboard PR #60** (`feat/nvidia-model-management`): added `NVIDIA_API_KEY` as a core API key, defaulted new agent configs to NVIDIA GLM-5.1 with Venice Claude Opus 4.6 fallback, narrowed the model picker to the requested NVIDIA/Venice model set, added model-picker help text, and bootstrapped NVIDIA auth profiles during deploy; PR #61 later corrected the runtime ID to `nvidia/z-ai/glm-5.1`
  - **Production deploy**: CI/CD deployed Cloud Run revision `openclaw-dashboard-00236-fxz` (100% traffic) and pushed tag `v2026.5.3.1`
- **Validation**:
  - Dashboard: `npx tsc --noEmit`, `npm run build`, GitHub Actions run `25273177168`
  - Runtime: `https://app.agentglob.com/login` returned `HTTP/2 200`

---

## Last Session (prev 2)

- **Date**: 2026-04-30 (dashboard GitHub MCP hotfix)
- **What changed**:
  - **vcode1bot (2ndclaw)**: fixed Telegram outage by removing the Docker-based `github` MCP entry that was crash-looping the gateway with `spawn docker EACCES`; `filesystem` and `brave-search` remain active
  - **Dashboard PR #59** (`hotfix/github-mcp-dashboard`): added a safe GitHub MCP quick setup preset, blocks Docker MCP commands, rejects token-looking args, installs the official GitHub MCP binary for agents, and maps saved `GITHUB_TOKEN` to `GITHUB_PERSONAL_ACCESS_TOKEN`
  - **Production deploy**: manually deployed hotfix to Cloud Run revision `openclaw-dashboard-00234-xh7` (100% traffic), then squash-merged PR #59 back to `main` and pushed tag `v2026.4.30.hotfix-github-mcp.1`
- **Validation**:
  - Dashboard: `npx tsc --noEmit`, `npm run build`
  - Runtime: `vcode1bot-openclaw-gateway-1` stayed `Up`; `https://app.agentglob.com/login` returned `HTTP/2 200`

---

## Last Session (prev 3)

- **Date**: 2026-04-20 (vcode1bot coding upgrade)
- **What changed**:
  - **vcode1bot (2ndclaw)**: upgraded to `venice/qwen3-coder-480b-a35b-instruct-turbo` (primary), added `filesystem` MCP (workspace r/w) and `brave-search` MCP (web search), added coding soul
  - **Dashboard PR #57** (`feat/coding-capability-template`): config template now uses coding model + MCP servers when `coding=true` capability flag is set — open for review/merge
  - Dashboard PR #53 `fix/control-deploy-infra` confirmed merged (commit `fix(agents): robust restart...` on main)

---

## Last Session (prev 4)

- **Date**: 2026-04-16 (CI runner fix)
- **What changed**:
  - **CI fix**: replaced Blacksmith third-party runners (`blacksmith-16vcpu-*`) with GitHub-hosted runners (`ubuntu-24.04`, `windows-latest`) across all 8 workflow files — Blacksmith integration was broken, leaving every workflow stuck in `queued` for 23+ hours
  - arm64 Docker build now uses QEMU emulation via `docker/setup-qemu-action` instead of a native arm runner
  - Added memory rule: always ask before integrating third-party CI/CD services
  - (prior in this session) Fixed Telegram group access, added `latest` GHCR tags, `deploy.sh` image-overwrite warning
- **Sync state**: re-check `STATUS.md` before creating a branch; one branch = one owner

---

## Currently In Progress

- None known

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

| Repo               | Branch                          | PR  | Status          | Owner   | Files / Areas Touched                    | Validation         | Next Concrete Step                       | Notes                                                                                                                      |
| ------------------ | ------------------------------- | --- | --------------- | ------- | ---------------------------------------- | ------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| openclaw-dashboard | codex/feat-widget-chat-v1       | #52 | merged+deployed | Codex   | Widget Chat V1 (widget tab, chat API/UI) | npm run build + CI | Monitor production behavior              | Merged to main; Cloud Run deploy run 24422489602 succeeded                                                                 |
| openclaw-dashboard | codex/fix-port-allocation-drift | #55 | merged+deployed | Codex   | agent creation, port allocation          | npm run build + CI | Monitor new-agent deploy behavior        | skips ports already claimed in live server state before allocation                                                         |
| openclaw-dashboard | codex/fix-deploy-port-repair    | #56 | merged+deployed | Codex   | deploy route, port reservation repair    | npm run build + CI | Monitor first-deploy conflict recovery   | auto-repairs stale reserved ports for never-deployed agents                                                                |
| openclaw-dashboard | feat/ci-cd-pipeline             | #51 | merged          | Claude  | GitHub Actions, Cloud Run pipeline       | merged             | None                                     | CI/CD auto-deploy live                                                                                                     |
| openclaw           | fix/deploy-and-control-infra    | #7  | merged          | Claude  | docker-compose.yml                       | n/a                | None                                     | Adds OPENCLAW_SKIP_BROWSER_CONTROL_SERVER env passthrough; merged Apr 15                                                   |
| openclaw-dashboard | fix/control-deploy-infra        | #53 | merged          | Claude  | control, logs, deploy routes             | merged             | None                                     | Merged Apr 20                                                                                                              |
| openclaw-dashboard | feat/coding-capability-template | #57 | merged+deployed | Claude  | lib/agent-config-template.ts             | npm run build + CI | None                                     | Merged Apr 20; coding=true previously used qwen3-coder + filesystem + brave-search MCPs                                    |
| openclaw-dashboard | hotfix/github-mcp-dashboard     | #59 | merged+deployed | Codex   | Tools MCP UI, MCP API route              | tsc + npm build    | Rotate leaked GitHub PAT; monitor setup  | Prod revision `openclaw-dashboard-00234-xh7`; tag `v2026.4.30.hotfix-github-mcp.1`                                         |
| openclaw-dashboard | feat/nvidia-model-management    | #60 | merged+deployed | Codex   | model config, secrets UI, deploy route   | tsc + npm build    | Superseded by #61 runtime-id hotfix      | Prod revision `openclaw-dashboard-00236-fxz`; tag `v2026.5.3.1`; initial default corrected to `nvidia/z-ai/glm-5.1` by #61 |
| openclaw-dashboard | hotfix/nvidia-designer-chat     | #61 | merged+deployed | Codex   | public chat models, config template      | tsc + npm build    | Monitor designer/GLM-5 landing behavior  | Prod revision `openclaw-dashboard-00237-6tr`; tag `v2026.5.3.2`; default `nvidia/z-ai/glm-5.1`                             |
| openclaw           | hotfix/nvidia-compose-env       | #10 | merged          | Codex   | docker-compose.yml, .env.example         | runtime smoke      | Include in next gateway image deploy     | Runtime compose file patched on EU/US so containers receive `NVIDIA_API_KEY`                                               |
| unknown            | chore/staging-deploy-gcp        | #1  | open, stale     | unknown | GCP deploy workflow                      | unknown            | Verify ownership before reuse or cleanup | Treat as active until verified                                                                                             |

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
