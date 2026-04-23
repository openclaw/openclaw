# Bootstrap Report

## OpenClaw Root Structure

- Repo root: `/home/ebatter1/openclaw-upstream`
- Core source layout: `src/`, `extensions/`, `skills/`, `docs/`, `packages/`, `apps/`
- Plugin manifests: `extensions/*/openclaw.plugin.json`
- Plugin entrypoints: `extensions/*/index.ts`
- Runtime-generated plugin bundles: `dist/`, `dist-runtime/`
- Workspace state: `~/.openclaw/workspace`
- User extensions: `~/.openclaw/extensions`
- Workspace skills: `~/.openclaw/workspace/skills`
- Workspace agent docs: `~/.openclaw/workspace/AGENTS.md`, `TOOLS.md`, `SOUL.md`, `HEARTBEAT.md`, `USER.md`
- Self-improving workspace steering: `~/.openclaw/workspace/skills/self-improving/` plus `~/self-improving/` (canonicalized at the tool boundary to `/var/lib/openclaw/workspace/self-improving/`, which is bind-mounted from `/var/lib/openclaw/self-improving/`)

## Existing Tool / Plugin Integration Points

- Manifest discovery and registration flow: `src/plugins/manifest-registry.ts`, `src/plugins/loader.ts`, `src/plugins/registry.ts`, `src/plugins/runtime.ts`
- Plugin config shape: `plugins.enabled`, `plugins.allow`, `plugins.deny`, `plugins.load.paths`, `plugins.entries.*`, `plugins.slots.memory`
- Skill config shape: `skills.load.extraDirs`, `skills.entries.*`, `skills.allowBundled`, `skills.install.*`
- Plugin/tool registration surface: `api.registerTool`, `api.registerCommand`, `api.registerService`, `api.registerHook`
- Existing memory plugin pattern: `extensions/memory-core/index.ts`
- Existing bundled tool plugin pattern: `extensions/tavily/index.ts`, `extensions/firecrawl/index.ts`
- Existing workspace-managed skill loading: `src/agents/skills/workspace.ts`
- Existing skill file convention: `SKILL.md` with front matter plus Markdown body

## Existing Skill Format

- Skill files are Markdown documents named `SKILL.md`
- Front matter contains `name`, `description`, and optional `metadata`
- Bundled resources live beside the skill in `scripts/`, `references/`, or `assets/`
- OpenClaw skill loading is rooted in `skills/`, `.agents/skills/`, and plugin-bundled skill directories
- Examples reviewed: `skills/coding-agent/SKILL.md`, `skills/skill-creator/SKILL.md`, `extensions/tavily/skills/tavily/SKILL.md`, `extensions/lobster/SKILL.md`

## Current Runbook / Document Locations

- Bootstrap spec pack: `/home/ebatter1/Documents/Memory Optimization runbook/`
- Primary docs in that pack:
  - `00-bootstrap/MASTER_BOOTSTRAP_SPEC.md`
  - `00-bootstrap/BOOTSTRAP_TASKLIST.md`
  - `05-prompts/CODEX_BOOTSTRAP_PROMPT.md`
  - `01-architecture/ARCHITECTURE.md`
  - `02-implementation/IMPLEMENTATION_PLAN.md`
  - `03-specs/RUNBOOK_SPEC.md`
  - `03-specs/RETRIEVAL_SPEC.md`
  - `04-tools/TOOLS_AND_SKILLS.md`
- Current OpenClaw operational docs in `/home/ebatter1/Documents/`:
  - `OPENCLAW-*.md` runbooks and plans
  - `openclaw-safe-install/README.md` and `openclaw-safe-install/staging/*`
- Workspace notes that already look like memory/control-plane artifacts:
  - `~/.openclaw/workspace/MEMORY.md.bak.20260329T220802Z`
  - `~/.openclaw/workspace/AGENTS.md`
  - `~/.openclaw/workspace/TOOLS.md`
- `~/self-improving/` in live docs, canonicalized by the tool boundary to `/var/lib/openclaw/workspace/self-improving/`

## Recommended Insertion Points For The New Runbook Memory Subsystem

- Canonical storage: `/home/ebatter1/openclaw-upstream/runbooks/`
- Backend package: `/home/ebatter1/openclaw-upstream/runbook_memory/`
- Migration/import entrypoint: `runbook_memory/tools/runbook_cli.py migrate`
- Indexing and retrieval entrypoints: `runbook_memory/tools/runbook_cli.py search|get|reindex`
- Maintenance entrypoints: `runbook_memory/tools/runbook_cli.py maintenance ...`
- Future OpenClaw plugin wrapper: `extensions/runbook-memory/` with `openclaw.plugin.json` and `index.ts`
- Future OpenClaw tool names: `runbook_search`, `runbook_get`, `runbook_create`, `runbook_update`, `runbook_review_queue`, `runbook_reindex`
- Future OpenClaw skill files: `author_runbook_from_change`, `answer_from_runbooks_first`, `maintenance_librarian`
- Future config integration: `plugins.entries.runbook-memory`, `plugins.load.paths`, and a runbook-memory-specific config block pointing to the SQLite DB and canonical runbooks tree

## Notes

- `python3` is available; `python` is not on PATH in this environment.
- `PyYAML` is installed, but the backend also includes a fallback parser path.
- The current backend stays entirely inside `runbook_memory/` and `runbooks/` as requested.
- For the OpenClaw gateway on this host, the stable install path is the
  `openclaw` user bus at `/run/user/996`; `openclaw gateway install` must run
  with `XDG_RUNTIME_DIR=/run/user/996` and the resulting user service should be
  enabled with `systemctl --user enable --now openclaw-gateway.service`.
- As of 2026-04-07, keep the `openclaw` user service enabled/active and keep the
  system `openclaw.service` disabled/inactive. If both services run, they fight
  over `127.0.0.1:18789` and Signal traffic can hit stale code.
- The `openclaw` account is `nologin`, so `sudo -iu openclaw` is not a valid
  operator path. Use `sudo -u openclaw -H` with the user bus environment instead.
- When deploying rebuilt JS into the live install manually, copy the whole
  matching `dist/` tree. Do not copy a single hashed bundle without its matching
  hashed dependencies.
- The live gateway now serves Control UI assets from
  `/var/lib/openclaw/control-ui` via `gateway.controlUi.root`, so backend-only
  package syncs cannot delete the browser UI. Refresh that directory with
  `pnpm ui:build` plus an `rsync` into `/var/lib/openclaw/control-ui/` when the
  UI bundle changes.
- On 2026-04-09, the live `self-improving` store was bind-mounted into
  `/var/lib/openclaw/workspace/self-improving/` so workspace-scoped file tools
  can reach it without tripping sandbox-root checks. The file-tool boundary now
  canonicalizes `~/self-improving/` to that mounted path, so workspace docs and
  the self-improving skill can keep the semantic alias instead of leaking the
  host mount.
- Signal group onboarding state as of 2026-04-07: `/addchat` from a trusted
  Signal sender adds the current group to `channels.signal.groupAllowFrom`;
  normal trusted-sender messages are temporarily not allowed to bootstrap new
  groups. Trusted sender checks use both `channels.signal.allowFrom` and
  `channels.signal.groupAllowFrom`.
- Signal group silence incident, 2026-04-07: if group chats are allowed but
  silent while DMs work, inspect session transcripts for `NO_REPLY` before
  assuming Signal access failure. The resolved cause was stale group-chat prompt
  guidance in live `AGENTS.md` plus the generated always-on group intro, cached
  in existing Signal group sessions with `systemSent: true`. Fix the prompt and
  expire only `agent:main:signal:group:*` session entries so new system prompts
  load; leave DM sessions untouched unless they show the same prompt issue.
- Signal group attachment gate, 2026-04-18: non-audio Signal group
  attachments/images and captions are held locally and stripped before media
  understanding or agent prompts until an authorized sender sends
  `/send_to_agent` in the same group. Signal voice/audio messages remain on the
  normal processing path, and the gate does not ask for per-attachment consent.
  The active service is the `openclaw` user `openclaw-gateway.service`; restart
  that user service after live bundle edits.

## Known Incident: Main Cron Routing and Fallback Policy

Observed on 2026-04-08 during the `To Do List` Signal chat investigation:

- `main` did have native `cron` on the live Signal owner path, and the installed
  bundle now preserves that invariant in the effective tool inventory.
- The source fix added explicit fallback guidance only when native `cron` is
  actually unavailable in the current runtime:
  - use `exec` to run `openclaw cron ...` when `cron` is missing but `exec`
    still exists
  - if both `cron` and `exec` are missing, delegate via `sessions_spawn`
    instead of failing silently
- This change was documented as a routing policy, not as a restriction on
  self-improving memory. `main` remains able to write to self-improving memory.

Operator response:

- keep the native `cron` tool in the `coding` profile for `main`
- treat missing-`cron` cases as a prompt-level fallback decision, not an agent
  crash
- prefer `sessions_spawn` only when both `cron` and `exec` are unavailable

## Known Incident: Control UI Cron Appears Paired But Still Fails

Observed on 2026-04-06 during operator debugging:

- Signal chats and Control UI cron failures looked related at first, but they were separate issues.
- Signal DM access was governed by DM pairing, while the cron tab depended on Control UI device pairing.
- The browser/device had to be re-approved with `openclaw devices approve --latest` before the cron tab could create jobs again.

Likely cause:

- The browser Control UI caches its device identity and device token in localStorage.
- A browser/profile/storage change, or a metadata pin change after an update, can make the gateway treat the session as a new device.
- The gateway then asks for device pairing again even though the UI already looks connected.

Operator response:

- Re-run `openclaw devices list`.
- Approve the pending device request, or use `openclaw devices approve --latest` if the request is clearly the Control UI browser.
- Refresh the web UI after approval so the client reconnects with the new trusted device state.
