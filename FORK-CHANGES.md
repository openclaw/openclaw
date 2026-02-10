# Fork-specific changes

Explicit listing of changes in this fork relative to upstream [OpenClaw](https://github.com/openclaw/openclaw). For sync procedure, see [.agent/workflows/update_clawdbot.md](.agent/workflows/update_clawdbot.md).

## ClawdBot-Next / prompt-engine integration

- **Agent system prompt** — Integrated [ClawdBot-Next](https://github.com/ClawdBot/ClawdBot-Next) prompt-engine:
  - `src/agents/prompt-engine/`: skills loader, triangulator, skill injector, system directives, types, clawd-matrix, data/skills.json.
  - `src/agents/system-prompt.ts`: uses `SkillsLoader`, `Triangulator`, `SkillInjector`, `SYSTEM_DIRECTIVES`; `buildAgentSystemPrompt` is async and accepts optional `userPrompt` for triangulation. OpenClaw-specific sections (safety, branding, `memoryCitationsMode`, sandbox) preserved.
  - `src/agents/pi-embedded-runner/system-prompt.ts`: passes `userPrompt` through to `buildAgentSystemPrompt` and awaits it.
- Kept in sync with upstream ClawdBot-Next where applicable; OpenClaw naming and config preserved where we diverge.

## Maintainer-specific changes

- **Documentation**
  - Root [README.md](README.md): “About this repository” section describing the fork, ClawdBot-Next integration, [docs/MAINTENANCE.md](docs/MAINTENANCE.md) link, and sync workflow link.
  - This file: explicit listing of fork changes and commit history.
  - [.agent/workflows/update_clawdbot.md](.agent/workflows/update_clawdbot.md): push policy and link to this file.
- **Ollama** — Support `OLLAMA_HOST` for cloud/remote discovery and requests (`8cb58d65d`). When `OLLAMA_HOST` is set, discovery uses a 15s timeout (vs 5s for local) to reduce timeouts on VPS/remote.
- **Build** — Copy `src/agents/prompt-engine/data/skills.json` to `dist/data/` and `dist/agents/prompt-engine/data/` during build via `scripts/copy-skills-data.ts` (tsdown does not copy non-TS assets; without this, the Skills Registry hits ENOENT at runtime). When the gateway runs as `node dist/index.js`, the loader resolves `dist/data/skills.json` first so it works with the bundled layout.
- **Build race (skills ENOENT)** — Avoid empty-`dist/` window during `pnpm build`: (1) `tsdown.config.ts` sets `clean: false` so the output dir is not wiped and `dist/data/` persists; (2) gateway eager-loads `SkillsLoader.loadLibrary()` at boot and caches in RAM so cron/agent turns never read disk during a build; (3) loader retries on ENOENT for a short window. See [MAINTENANCE.md](docs/MAINTENANCE.md) “Build-phase race”.
- **Maintenance** — [docs/MAINTENANCE.md](docs/MAINTENANCE.md): fork update workflow, stop-before-rebuild, avoiding `openclaw doctor`/`gateway install` overwrites, health-check script for VPS/repo installs, and **Why skills.json can disappear** (agent running `git clean -fd` in repo workspace; restore via `pnpm build`; gateway fallback loads from source when dist copy is missing).
- **Skills loader** — Resolves `skills.json` in order: `dist/data/skills.json` (when argv[1] is `.../dist/index.js`), then same-dir `data/skills.json`, then `src/agents/prompt-engine/data/skills.json`. If the dist copy is missing, logs `Loaded skills from source path (dist copy missing)` and may retry; gateway boot preloads the library into a static singleton so the running process does not depend on disk after startup.
- **Agent loop** — One config/restart/cron change per request; report and ask before retry (`394341893`).
- **Build** — Type fix for `SkillLibrary` in `selectSkillsForContext` (plugin-sdk dts build) (`ffe83456b`). Copy `skills.json` to dist during build (`scripts/copy-skills-data.ts`).
- **Cron zombie scheduler fix** — Seven changes to prevent and recover from a stuck scheduler:
  - Re-arm timer in catch block when `onTimer` throws.
  - Re-arm on `cron list` / `cron status` when timer is dead (zombie recovery).
  - Watchdog timer (every 2.5 min) re-arms if main timer dies.
  - **Anti-zombie self-healing**: secondary check-in every 60s; if no timer tick completes within 60s (e.g. event loop blocked), the scheduler re-initializes (clear timer, re-arm) so the service does not stay "Active" with jobs frozen. Unit tests in `src/cron/service.anti-zombie.test.ts` cover re-init when idle and no false positive when a recent tick completed.
  - Per-job dynamic stuck threshold (`runningAtMs`) based on job timeout.
  - Stale `state.running` recovery when `onTimer` hangs.
  - Troubleshooting docs for "Cron stuck (zombie scheduler)".
- _(Add further customizations, fixes, or config here as you make them.)_

## Workflow / tooling

- **Sync workflow** — [.agent/workflows/update_clawdbot.md](.agent/workflows/update_clawdbot.md): steps for rebasing/merging from upstream (ClawdBot-Next and OpenClaw), conflict patterns, prompt-engine merge notes, rebuild and verify steps.
- Push policy: only to this fork; never push to ClawdBot-Next or OpenClaw upstream.

## Commit history (fork-only)

Commits on this fork’s `main` that are not in upstream OpenClaw (oldest first). Generated from `git log upstream/main..origin/main --oneline --no-merges`.

| Commit      | Description                                                                             |
| ----------- | --------------------------------------------------------------------------------------- |
| `b840d2be4` | Integrate ClawdBot-Next prompt-engine into system prompt                                |
| `31f034440` | Docs: add push policy to update_clawdbot workflow (push only to fork)                   |
| `ffe83456b` | fix: type SkillLibrary in selectSkillsForContext (fix build:plugin-sdk:dts)             |
| `8cb58d65d` | Ollama: support OLLAMA_HOST for cloud/remote discovery and requests                     |
| `394341893` | Agent loop-prevention: one config/restart/cron per request, report and ask before retry |
| `9a58bb654` | README: add fork notice, ClawdBot-Next integration, and from-source clone note          |
