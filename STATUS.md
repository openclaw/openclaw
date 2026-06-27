# OpenClaw — Dev Status

> Claude and Codex read this at session start and update it at session end.
> Repo-root `STATUS.md` is the only live source of truth. Do not use the legacy copy at `/Users/liranperetz/Claw_01_on_Hetzner_server/STATUS.md` unless explicitly asked.

---

## Last Session

- **Date**: 2026-06-27 (deterministic durable-memory recall shipped to prod: `life` v2026.06.27.1)
- **What changed**:
  - **Gateway PR #90** (`feat/app-memory-recall-injection`): fixes QA 4A — a goal saved in one app chat wasn't recalled in a new chat. Root cause (verified): saving works (Graphiti `add_episode` succeeds; a live `search_memory_facts` returns the fact), but recall was **discretionary** — the slim app prompt often skipped `search_memory_facts` at the start of a new chat. New `src/agents/graphiti-recall-client.ts` (read-only `search_memory_facts` over streamable-HTTP MCP, mirrors the graphiti-proxy scope boundary: server-derived `groupId` only, unsafe-id fail-closed, `group_ids:[groupId]`, no caller `group_id`/`group_ids`/`center_node_uuid`) + `src/agents/memory-recall-context.ts` (`appendMemoryRecallBootstrapFile` — group id byte-identical to the `life-memory-scope` hook, ~2.5s timebox + fail-open, **no cross-turn cache** per codex P2) chained after `appendAppProfileBootstrapFile` in `bootstrap-files.ts`. Injects the top facts as a synthetic `MEMORY_RECALL.md` every app turn. Folded a codex review round (P1 scope boundary + P2 stale-cache). 27 vitest; `pnpm check` green.
  - **Gateway image `v2026.06.27.1`** (sourceSha `ed9f2a5c8`): built from `main`, pinned to **`life` only** on 2ndClaw via single-agent recreate (fleet untouched per the staged-boot rule). Rollback ref `v2026.06.20.3` (`docker.env.bak.pre-v2026.06.27.1`).
  - **`life` `workspace/AGENTS.app.md`**: one-line note in §3 that the top durable facts are pre-injected as `MEMORY_RECALL.md` (lean on it first, `search_memory_facts` only for more). Host-only, effective next turn (`AGENTS.app.md.bak.pre-memory-recall`); source mirrored in `ops/graphiti-life/agents-md-memory-section.md`.
  - **Companion app fix**: `app.havaya` #28 (summary-method parser keeps custom output — QA 4C — + QA-guide doc fixes) merged/auto-deploys via Coolify.
- **Validation**:
  - `pnpm check` green on #90 (tsgo + lint + oxfmt); 27 vitest incl. wire/scope/timebox + hook group-id parity + fail-open + no-stale-cache.
  - Prod smoke: `life` recreated on `v2026.06.27.1`, boots healthy (gateway `:18789`, graphiti mcp ready: 4 tools, restarts=0). Public-chat coherence reply OK. **Memory-recall E2E confirmed**: a brand-new app session for the QA test user asking "מה המטרה שלי החודש?" now replies "המטרה שלך החודש היא לבנות שגרת כתיבה יומית" on the FIRST message (was: asked to be reminded).
- **Follow-ups**: register release `v2026.06.27.1` (owner/dashboard `POST /api/platform/releases`); the daily `bug_list` autoscan cron re-drifts `scripts/ops/bug_list.md` under oxfmt 0.33 — make the cron format or ignore it (the `check` gate fails on every PR until then; #90 folded a one-off fix); periodic US-host image prune.

## Last Session (prev)

- **Date**: 2026-06-18 (load_skill app-session tool shipped to prod: v2026.06.18.1; US disk cleanup)
- **What changed**:
  - **Gateway PR #74** (`feat/load-skill-app-sessions`): read-only, name-scoped `load_skill` tool so Havaya app-user sessions (jailed by `tools.fs.workspaceOnly`) can load + apply the live dashboard skills they could previously see but not read. Allowlist = the prompt-limited filtered `resolvedSkills` (no side channel, no drift with the prompt); confined to each matched entry's own `baseDir`; gated on a resolved app user (turn-1-safe via the #71 fallback); 24 KB cap. The app skills prompt is path-free (`load_skill(name)`, no `<location>` leak) and mirrored into compaction. Folded two codex rounds (4519976882 tool-filter/compaction/limits + 4520156223 doc nit). Merged clean (no `--admin`).
  - **Gateway image `v2026.06.18.1`** (sourceSha `09a99e476`): built from `main`, pinned to **`life` only** on 2ndClaw (single-agent recreate). Ships the FULL per-user stack to prod (writer #65/#66 + injection #68 + first-turn #71 + load_skill #74). Rollback ref `v2026.06.17.2` (`docker.env.bak.pre-v2026.06.18.1`).
  - **US-host disk cleanup**: the v2026.06.18.1 pre-pull hit "no space left" (2ndClaw at 97% from gateway-image drift). Freed 22 GB (97% to 67%) by `docker rmi` of 8 unused registry gateway tags — verified unreferenced by any container, all re-pullable from Artifact Registry; in-use tags kept. Recurring: each roll adds ~8.5 GB, so prune unused tags when rolling.
- **Validation**:
  - `pnpm check` green on #74 (tsgo + lint); vitest load-skill 11 + system-prompt.skills 8 + overflow-compaction; oxfmt.
  - Prod smoke: `life` recreated on `v2026.06.18.1`, boots healthy (gateway `:18789`, graphiti mcp ready, telegram up); public-chat smoke returned a coherent in-persona reply.
- **Follow-ups**: optional `AGENTS.md` prose (reinforcing; the system prompt already instructs `load_skill`); register release `v2026.06.18.1` (owner/dashboard); retire the Havaya Drive "embedded" summary method -> load the live `tal-meeting-summary` skill; periodic US-host image prune.

## Last Session (prev)

- **Date**: 2026-06-17 (Per-user profile Phase 3 shipped to prod: app_profile injection + CI gate; **first-turn fix #71** rolled the same day)
- **What changed**:
  - **Gateway PR #68** (`feat/app-profile-context`): inject each app-user's `app_profile` section into the agent context every turn as a synthetic `APP_PROFILE.md` bootstrap file, so `life` always knows the user without being reminded. New `src/agents/app-profile-context.ts` (fail-closed marker extractor, UTF-8 byte-safe 2 KB clamp, app-session-only via `isAppUserSession` + `resolveAppUserId`); 3-line wire in `src/agents/bootstrap-files.ts` (after hook overrides, before the context-file budget clamp; compaction-safe). 14/14 vitest; resolved per-run so no cross-user leak.
  - **Gateway PR #69** (`fix/tsgo-type-errors`): greened the `check` (tsgo + oxlint) and `check-docs` (markdownlint + link-check) CI gates so openclaw PRs stop needing `--admin`. `chat.ts` typed to the real `AssistantContentBlock[]` union (one commented boundary cast, no `any`); 3 test-mock fixes; unused import + 3 redundant type-args dropped; doc lint/link fixes.
  - **Gateway image `v2026.06.17.1`** (sourceSha `50f6c2d6f`): built from `main`, pushed to Artifact Registry, pinned to **`life` only** on 2ndClaw via single-agent recreate (fleet untouched per the staged-boot rule). Rollback ref `v2026.06.13.1` (`docker.env.bak.pre-v2026.06.17.1`).
  - **`life` `workspace/AGENTS.md`**: added the `app_profile` writable section + maintenance rules (sections 4/5) so the agent keeps a concise running brief (`name` / `call_them` / `summary`). Host-only, effective next turn (`AGENTS.md.bak.pre-app-profile-prose`).
  - **Phase 2 (`app.havaya` #24)**: confirmed already auto-deployed on merge (Coolify webhook); the home greeting reads the name from the per-user file.
  - **Gateway PR #71** (`fix/app-profile-first-turn`): the injection missed the FIRST turn of every new session. `appUserId` is read from the persisted session entry, but `chat.send` only writes it onto an EXISTING entry (`updateSessionStoreEntry` no-ops when missing), so a brand-new session's first message ran with no `APP_PROFILE.md` and the agent asked the user's name (every page refresh / new chat hit this; from turn 2 on it worked). Added `appUserIdFromSessionKey()` fallback in `app-profile-context.ts` (derives the id from the session key — second-to-last `:`-segment after `:app:` — when the entry lacks it; read-only, same-user, leaves the shared `resolveAppUserId` / workspace-jail / writer untouched). Also braced this file's guard-returns → repo-wide `pnpm lint` now green (it was the only lint-dirty file). 22/22 vitest; merged without `--admin`.
  - **Gateway image `v2026.06.17.2`** (sourceSha `d4ae21509`): built from `main`, pinned to **`life` only** on 2ndClaw via single-agent recreate (fleet untouched). Rollback ref `v2026.06.17.1` (`docker.env.bak.pre-v2026.06.17.2`).
- **Validation**:
  - `pnpm check` + `pnpm check:docs` green on #69; `app-profile-context` 14/14 vitest; image build compiled clean.
  - Prod smoke: `life` recreated on `v2026.06.17.1`, boots healthy (gateway `:18789`, graphiti mcp ready, telegram up); public-chat smoke returned a coherent in-persona reply. 2 of 4 live user files already carry a seeded `app_profile` `name:` marker.
  - **#71 fix prod-verified**: reproduced the bug (fresh-session first "Hi" → "what's your name?"), then after rolling `v2026.06.17.2` a fresh-session first "Hi" greeted "היי לירן" (by name) without asking; `life` re-verified healthy on `v2026.06.17.2`.
- **Follow-ups**: register releases `v2026.06.17.1` (`50f6c2d6f`) and `v2026.06.17.2` (`d4ae21509`) via the dashboard `/api/platform/releases` (bookkeeping; optional dashboard step, prior rolls skipped it without harm).

## Last Session (prev 2)

- **Date**: 2026-06-01 / 2026-06-02 (Havaya per-user integration — writer + reader + parity)
- **What changed**:
  - **Gateway PR #49** (`feat/save-user-section-tool`): new `save_user_section` agent tool writing allowlisted sections (`User_D_Prompt`, `app_note`) to `workspace/users/<appUserId>.md` with HTML-comment markers and fail-closed upsert. Added `appUserId?: string` to `SessionEntry` (`src/config/sessions/types.ts`), `ChatSendParamsSchema` (`src/gateway/protocol/schema/logs-chat.ts`), and `chat.send` handler (`src/gateway/server-methods/chat.ts`) — persists `appUserId` from the incoming RPC onto the session entry before dispatch so the tool can resolve identity server-side without the model passing a user id. Registered in `src/agents/openclaw-tools.ts` (only when `appUserId` resolves). 9 vitest unit tests (`src/agents/tools/save-user-section.test.ts`).
  - **Dashboard PR #107**: per-user workspace-file reader endpoint `GET /api/public/chat/[agentName]/user-file?userId=&section=`. Single module `lib/user-file-core.ts` (pure helpers + DI orchestrator). Route glue: timing-safe app-key auth (`AGENTGLOB_APP_API_KEY`), SSH stat-first + read via `lib/ssh-client.ts`, in-memory TTL cache, per-key rate limit, ETag/304/Vary validation. 30 unit tests (node:test). Section allowlist: `User_D_Prompt`, `app_note`.
  - **Dashboard PR #108**: threads `appUserId` from the public chat POST body through `chatSendAndWait` into gateway `chat.send` params (`lib/gateway-client.ts` + `app/api/public/chat/[agentName]/route.ts`).
  - **Dashboard PR #110**: parity — `chatSendStream` and the `/stream` route also forward `appUserId` (prevents silent identity drop if a consumer switches to the streaming/voice UI).
  - **Gateway image `v2026.06.01.1`**: built from `origin/main` (SHA `ef5cdc992`) via fresh detached worktree (skipped dirty main checkout). Deployed to **`life` only** on 2ndClaw; all other agents remain on `v2026.05.24.x`.
  - **`life` `workspace/AGENTS.md`**: added **App Profile Sections (Havaya web app)** guidance block (backup at `AGENTS.md.bak.20260601`). No redeploy needed — read on next agent turn.
  - **Docs PRs**: openclaw #51 (`docs/tools/save-user-section.md` + `docs.json` nav); openclaw-dashboard #109 (as-built + plan SHIPPED banner); app.havaya #3 (consumer), #4 (as-built status), #6 (key redaction).
  - **Security remediation**: a parallel-session PR committed the live `AGENTGLOB_APP_API_KEY` in plaintext. Key rotated on both the dashboard (Cloud Run) and Havaya (Coolify). Havaya `main` history rewritten (narrow 2-commit filter-branch); `feat/ui-tweaks` rebased onto clean main. All repos verified 0 reachable key occurrences.
- **Validation**:
  - Gateway: `pnpm check` (tsgo + oxfmt + oxlint) — pre-existing red CI (format drift + unrelated test errors); admin-merged per owner decision. `save-user-section.test.ts` 9/9 vitest pass.
  - Dashboard: `npx tsc --noEmit` clean; `npm run build` exit 0 for PRs #107, #108, #110.
  - Runtime smoke (prod): `GET /api/public/chat/life/user-file` — no key→401, valid key + missing file→404, non-allowlist→404, wrong key→401 ✅. Real user write confirmed: `users/user_3erjup5l2qciurikq1buqtxlglj.md` written by the `life` agent with correct marker format. Post-rotation smoke: old key→401, new key→200 ✅.

---

## Last Session (prev 2)

- **Date**: 2026-05-12 (projectmanager wallet chat access)
- **What changed**:
  - Gateway branch `codex/fix-wallet-chat-access`: added `skills/wallet/SKILL.md` so deployed agents can use the AgentGlob wallet runtime from chat.
  - Dashboard branch `codex/fix-wallet-chat-access`: deploy now syncs selected/platform-native skills on every redeploy, not only first bootstrap; Wallet tab now warns that redeploy is required for chat access after setting/replacing the key.
  - Built and deployed gateway tag `v2026.05.12.1` from SHA `4f88a87d5`; rollout completed on 1stClaw (14/14) and 2ndClaw (13/13).
  - Live repair completed for `projectmanager` on 2ndClaw: `AGENTGLOB_RUNTIME_URL`, `AGENTGLOB_RUNTIME_TOKEN`, and `workspace/skills/wallet/SKILL.md` are present, and only `projectmanager` was recreated after the env/skill repair.
- **Validation**:
  - Dashboard: `npx tsc --noEmit`, `npm run build`
  - Dashboard Cloud Run deploy: GitHub Actions run `25730530962` completed successfully for SHA `a2e7867`
  - Gateway: `pnpm build`, `pnpm check:docs`, `/opt/openclaw-ops/scripts/build-and-push.sh v2026.05.12.1`, `/opt/openclaw-ops/scripts/deploy.sh v2026.05.12.1`
  - Runtime: `projectmanager` wallet balance endpoint returned HTTP 200 on Ethereum, Arbitrum, Polygon, and Base; Arbitrum balance returned `0.000561686456576002 ETH`, other native balances returned `0`.

---

## Last Session (prev)

- **Date**: 2026-05-05 (handover note)
- **What changed**:
  - Added repo-root `HANDOVER.md` as the front-door handoff note for future Claude/Codex sessions
  - The note includes SSH instructions, required files to read before starting, branch/PR protocol, dashboard and gateway deploy protocols, relevant NVIDIA/model files, runtime paths, smoke tests, and the end-of-session checklist
- **Validation**:
  - Documentation-only change; reviewed rendered markdown content on DevAgents

---

## Last Session (prev)

- **Date**: 2026-05-04 (Jojo PM NVIDIA fallback hotfix)
- **What changed**:
  - **Jojo PM / projectmanager (2ndClaw)**: repaired existing config by adding the dashboard-supported NVIDIA model definitions, changing primary back to `nvidia/z-ai/glm-5.1`, and placing `venice/claude-opus-4-6` first in fallbacks
  - **Dashboard PR #62** (`hotfix/nvidia-existing-agent-models`): backfills NVIDIA model definitions on existing-agent config saves, normalizes the old GLM runtime id, and retries public chat on Claude Opus 4.6 when a selected NVIDIA model fails
  - **Dashboard PR #63** (`hotfix/public-chat-default-fallback`): extends the public-chat Claude fallback retry to stale/no-explicit-model clients when the gateway default NVIDIA model fails
  - **Production deploys**: CI/CD deployed Cloud Run revisions `openclaw-dashboard-00238-4s6` and `openclaw-dashboard-00239-bl9`; latest tag `v2026.5.4.2`
- **Validation**:
  - Dashboard: `npx tsc --noEmit`, `npm run build`, GitHub Actions runs `25341349408` and `25344858302`
  - Runtime: Jojo PM selected DeepSeek-R1 public chat returned `jojo-deepseek-fallback-live-ok` via fallback; Jojo PM no-explicit-model public chat returned `jojo-default-fallback-live-ok`

---

## Last Session (prev 2)

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

## Last Session (prev 3)

- **Date**: 2026-05-03 (dashboard NVIDIA model defaults)
- **What changed**:
  - **Dashboard PR #60** (`feat/nvidia-model-management`): added `NVIDIA_API_KEY` as a core API key, defaulted new agent configs to NVIDIA GLM-5.1 with Venice Claude Opus 4.6 fallback, narrowed the model picker to the requested NVIDIA/Venice model set, added model-picker help text, and bootstrapped NVIDIA auth profiles during deploy; PR #61 later corrected the runtime ID to `nvidia/z-ai/glm-5.1`
  - **Production deploy**: CI/CD deployed Cloud Run revision `openclaw-dashboard-00236-fxz` (100% traffic) and pushed tag `v2026.5.3.1`
- **Validation**:
  - Dashboard: `npx tsc --noEmit`, `npm run build`, GitHub Actions run `25273177168`
  - Runtime: `https://app.agentglob.com/login` returned `HTTP/2 200`

---

## Last Session (prev 4)

- **Date**: 2026-04-30 (dashboard GitHub MCP hotfix)
- **What changed**:
  - **vcode1bot (2ndclaw)**: fixed Telegram outage by removing the Docker-based `github` MCP entry that was crash-looping the gateway with `spawn docker EACCES`; `filesystem` and `brave-search` remain active
  - **Dashboard PR #59** (`hotfix/github-mcp-dashboard`): added a safe GitHub MCP quick setup preset, blocks Docker MCP commands, rejects token-looking args, installs the official GitHub MCP binary for agents, and maps saved `GITHUB_TOKEN` to `GITHUB_PERSONAL_ACCESS_TOKEN`
  - **Production deploy**: manually deployed hotfix to Cloud Run revision `openclaw-dashboard-00234-xh7` (100% traffic), then squash-merged PR #59 back to `main` and pushed tag `v2026.4.30.hotfix-github-mcp.1`
- **Validation**:
  - Dashboard: `npx tsc --noEmit`, `npm run build`
  - Runtime: `vcode1bot-openclaw-gateway-1` stayed `Up`; `https://app.agentglob.com/login` returned `HTTP/2 200`

---

## Last Session (prev 4)

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

- Codex owns `openclaw` branch `codex/feat-rain-agent-skills` / PR #19 for the Rain skill scaffold. Scope: `skills/rain/SKILL.md`, `STATUS.md`. This intentionally avoids dashboard wallet/RPC files while Claude owns the AgentGlob wallet integration.
- Claude owns `openclaw` branch `feat/rain-skill-split` for the Rain skill rewrite + create-market split per the plan in `docs/plans/rain-skill-rewrite.md` (merged via PR #44). Scope: `skills/rain/SKILL.md` (expanded — adds portfolio, analytics, trade-history, utility, diagnostics sections; removes create-market flow), `skills/rain-create/SKILL.md` (new), `STATUS.md`. No code or MCP changes.
- Claude owns `openclaw` branch `fix/skills-bundled-empty-env-fallback` — small follow-up to PR #47 fixing the `buildEnvOr` empty-string handling so `OPENCLAW_IMAGE_*` env vars default to `"unknown"` when the build-arg is unset (Dockerfile defaults to `""`, and `??` doesn't fall back on `""`). Scope: `src/gateway/routes/skills-bundled.ts`, `src/gateway/routes/skills-bundled.test.ts`, `STATUS.md`.
- Ops change applied on DevAgents (2026-05-24): `/opt/openclaw-ops/scripts/build-and-push.sh` now passes `--build-arg OPENCLAW_IMAGE_TAG="${TAG}"` and `--build-arg OPENCLAW_SOURCE_SHA="${SOURCE_SHA}"`. Backup at `build-and-push.sh.bak.<ts>`. `OPENCLAW_IMAGE_SHA` intentionally not passed — the registry digest isn't known inside a single-pass `docker build` (per Codex's nuance note on PR #47); release-record join in Phase 3 will populate it. Until then the gateway reports `"imageSha": "unknown"`.

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

| Repo               | Branch                              | PR  | Status          | Owner   | Files / Areas Touched                                                                                               | Validation             | Next Concrete Step                                             | Notes                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------- | --- | --------------- | ------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openclaw-dashboard | codex/feat-widget-chat-v1           | #52 | merged+deployed | Codex   | Widget Chat V1 (widget tab, chat API/UI)                                                                            | npm run build + CI     | Monitor production behavior                                    | Merged to main; Cloud Run deploy run 24422489602 succeeded                                                                                                                                                              |
| openclaw-dashboard | codex/fix-port-allocation-drift     | #55 | merged+deployed | Codex   | agent creation, port allocation                                                                                     | npm run build + CI     | Monitor new-agent deploy behavior                              | skips ports already claimed in live server state before allocation                                                                                                                                                      |
| openclaw-dashboard | codex/fix-deploy-port-repair        | #56 | merged+deployed | Codex   | deploy route, port reservation repair                                                                               | npm run build + CI     | Monitor first-deploy conflict recovery                         | auto-repairs stale reserved ports for never-deployed agents                                                                                                                                                             |
| openclaw-dashboard | feat/ci-cd-pipeline                 | #51 | merged          | Claude  | GitHub Actions, Cloud Run pipeline                                                                                  | merged                 | None                                                           | CI/CD auto-deploy live                                                                                                                                                                                                  |
| openclaw           | fix/deploy-and-control-infra        | #7  | merged          | Claude  | docker-compose.yml                                                                                                  | n/a                    | None                                                           | Adds OPENCLAW_SKIP_BROWSER_CONTROL_SERVER env passthrough; merged Apr 15                                                                                                                                                |
| openclaw-dashboard | fix/control-deploy-infra            | #53 | merged          | Claude  | control, logs, deploy routes                                                                                        | merged                 | None                                                           | Merged Apr 20                                                                                                                                                                                                           |
| openclaw-dashboard | feat/coding-capability-template     | #57 | merged+deployed | Claude  | lib/agent-config-template.ts                                                                                        | npm run build + CI     | None                                                           | Merged Apr 20; coding=true previously used qwen3-coder + filesystem + brave-search MCPs                                                                                                                                 |
| openclaw-dashboard | hotfix/github-mcp-dashboard         | #59 | merged+deployed | Codex   | Tools MCP UI, MCP API route                                                                                         | tsc + npm build        | Rotate leaked GitHub PAT; monitor setup                        | Prod revision `openclaw-dashboard-00234-xh7`; tag `v2026.4.30.hotfix-github-mcp.1`                                                                                                                                      |
| openclaw-dashboard | feat/nvidia-model-management        | #60 | merged+deployed | Codex   | model config, secrets UI, deploy route                                                                              | tsc + npm build        | Superseded by #61 runtime-id hotfix                            | Prod revision `openclaw-dashboard-00236-fxz`; tag `v2026.5.3.1`; initial default corrected to `nvidia/z-ai/glm-5.1` by #61                                                                                              |
| openclaw-dashboard | hotfix/nvidia-designer-chat         | #61 | merged+deployed | Codex   | public chat models, config template                                                                                 | tsc + npm build        | Monitor designer/GLM-5 landing behavior                        | Prod revision `openclaw-dashboard-00237-6tr`; tag `v2026.5.3.2`; default `nvidia/z-ai/glm-5.1`                                                                                                                          |
| openclaw-dashboard | hotfix/nvidia-existing-agent-models | #62 | merged+deployed | Codex   | config save, public chat fallback                                                                                   | tsc + npm build        | Monitor Jojo PM fallback behavior                              | Prod revision `openclaw-dashboard-00238-4s6`; tag `v2026.5.4.1`; backfills existing configs                                                                                                                             |
| openclaw-dashboard | hotfix/public-chat-default-fallback | #63 | merged+deployed | Codex   | public chat fallback                                                                                                | tsc                    | Monitor stale/no-model clients                                 | Prod revision `openclaw-dashboard-00239-bl9`; tag `v2026.5.4.2`; default NVIDIA failures retry Claude                                                                                                                   |
| openclaw           | hotfix/nvidia-compose-env           | #10 | merged          | Codex   | docker-compose.yml, .env.example                                                                                    | runtime smoke          | Include in next gateway image deploy                           | Runtime compose file patched on EU/US so containers receive `NVIDIA_API_KEY`                                                                                                                                            |
| openclaw           | codex/feat-rain-agent-skills        | #19 | open            | Codex   | skills/rain/SKILL.md, STATUS.md                                                                                     | tests + format         | Review PR #19; merge after wallet/RPC path is ready if desired | Depends on AgentGlob wallet runtime/Alchemy RPC work for wallet-backed execution; no dashboard wallet files touched                                                                                                     |
| openclaw           | feat/rain-skill-split               | TBD | in progress     | Claude  | skills/rain/SKILL.md, skills/rain-create/SKILL.md, STATUS.md                                                        | docs-only              | Open PR, request Codex review                                  | Implements plan from PR #44 (`docs/plans/rain-skill-rewrite.md`). No code changes. Wallet-level create-market gate is a separate follow-up.                                                                             |
| openclaw           | feat/skill-registry-manifest        | TBD | in progress     | Claude  | scripts/generate-skills-manifest.ts, src/gateway/routes/skills-bundled.ts, skills/manifest.json, Dockerfile, ci.yml | pnpm build + pnpm test | Open PR                                                        | Phase 1 worker side of canonical skill registry plan (PR #46 / SHA 8686c48df). Adds manifest generator, bundled endpoints, pre-commit hook, CI check. Dashboard side is a separate PR (feat/skill-registry-install-ui). |
| unknown            | chore/staging-deploy-gcp            | #1  | open, stale     | unknown | GCP deploy workflow                                                                                                 | unknown                | Verify ownership before reuse or cleanup                       | Treat as active until verified                                                                                                                                                                                          |

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
