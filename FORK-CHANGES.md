# Fork-specific changes

Explicit listing of changes in this fork relative to upstream [OpenClaw](https://github.com/openclaw/openclaw). For sync procedure, see [.agent/workflows/update_clawdbot.md](.agent/workflows/update_clawdbot.md).

## ClawdBot-Next / prompt-engine integration

- **Agent system prompt** — Integrated [ClawdBot-Next](https://github.com/ClawdBot/ClawdBot-Next) prompt-engine:
  - `src/agents/prompt-engine/`: skills loader, triangulator, skill injector, system directives, types, clawd-matrix, data/skills.json.
  - `src/agents/system-prompt.ts`: uses `SkillsLoader`, `Triangulator`, `SkillInjector`, `SYSTEM_DIRECTIVES`; `buildAgentSystemPrompt` is async and accepts optional `userPrompt` for triangulation. OpenClaw-specific sections (safety, branding, `memoryCitationsMode`, sandbox) preserved.
  - `src/agents/pi-embedded-runner/system-prompt.ts`: passes `userPrompt` through to `buildAgentSystemPrompt` and awaits it.
- Kept in sync with upstream ClawdBot-Next where applicable; OpenClaw naming and config preserved where we diverge.

## Maintainer-specific changes

### Documentation and maintenance

- **Docs + metadata**
  - Root [README.md](README.md): “About this repository” section describing the fork, ClawdBot-Next integration, [docs/MAINTENANCE.md](docs/MAINTENANCE.md) link, and sync workflow link.
  - This file: explicit listing of fork changes and commit history.
  - [.agent/workflows/update_clawdbot.md](.agent/workflows/update_clawdbot.md): push policy and link to this file.
- **Maintenance runbook**
  - [docs/MAINTENANCE.md](docs/MAINTENANCE.md): fork update workflow, stop-before-rebuild, avoiding `openclaw doctor`/`gateway install` overwrites, health-check script for VPS/repo installs, and **Why skills.json can disappear** (agent running `git clean -fd` in repo workspace; restore via `pnpm build`; gateway fallback loads from source when dist copy is missing).

### Prompt-engine, skills loader, and build pipeline

- **Skills data packaging**
  - Copy `src/agents/prompt-engine/data/skills.json` to `dist/data/` and `dist/agents/prompt-engine/data/` during build via `scripts/copy-skills-data.ts` (tsdown does not copy non-TS assets; without this, the Skills Registry hits ENOENT at runtime). When the gateway runs as `node dist/index.js`, the loader resolves `dist/data/skills.json` first so it works with the bundled layout.
- **Build race (skills ENOENT) hardening**
  - Avoid empty-`dist/` window during `pnpm build`: (1) `tsdown.config.ts` sets `clean: false` so the output dir is not wiped and `dist/data/` persists; (2) gateway eager-loads `SkillsLoader.loadLibrary()` at boot and caches in RAM so cron/agent turns never read disk during a build; (3) loader retries on ENOENT for a short window. See [MAINTENANCE.md](docs/MAINTENANCE.md) “Build-phase race”.
- **Skills loader resolution**
  - Resolves `skills.json` in order: `dist/data/skills.json` (when `argv[1]` is `.../dist/index.js`), then same-dir `data/skills.json`, then `src/agents/prompt-engine/data/skills.json`. If the dist copy is missing, logs `Loaded skills from source path (dist copy missing)` and may retry; gateway boot preloads the library into a static singleton so the running process does not depend on disk after startup.
- **Type/SDK fixes**
  - Type fix for `SkillLibrary` in `selectSkillsForContext` (plugin-sdk dts build) and ensured `skills.json` is copied to dist during build.

### Gateway tools and execution controls

- **Gateway tools: stderr piping**
  - Exec/process tools now surface **truncated stderr** in tool results for better self-correction:
    - `exec` synchronous failures attach a `stderr` field on the tool error (last 50 lines, max ~2KB), which is then exposed in the JSON tool result returned to the model.
    - Background exec sessions tracked via the `process` tool include a truncated `stderr` tail in `details` for `list`, `poll`, and `log` actions when available.
  - Implementation lives in `src/agents/bash-tools.exec.ts`, `src/agents/bash-tools.process.ts`, `src/agents/bash-process-registry.ts`, and the generic adapter `src/agents/pi-tool-definition-adapter.ts`.
  - Tests: `src/agents/pi-tool-definition-adapter.test.ts`, `src/agents/bash-tools.exec.background-abort.test.ts`, and `src/agents/bash-tools.process.send-keys.test.ts` cover stderr truncation and wiring.
- **Tool-level concurrency locks (singleton tools)**
  - Plugin tools (skills) that shell out to host CLIs can be marked as **singletons** via the `OPENCLAW_SINGLETON_TOOLS` env var (comma-separated, normalized names). When enabled for a tool name, the gateway wraps that plugin tool’s `execute` in a per-name semaphore so only one invocation per tool runs at a time; concurrent calls are queued instead of failing with transient CLI errors (for example `"Command exited with code 1"` when multiple agents hit a Twitter/email CLI simultaneously). Configuration is operational-only; no code changes are required to add/remove singleton tools. See [docs/MAINTENANCE.md](docs/MAINTENANCE.md) “Tool-level concurrency locks for CLI-backed skills”.
- **Agent loop guardrails**
  - One config/restart/cron change per request; report and ask before retry (`394341893`).
- **Native compaction command**
  - **CLI:** `openclaw memory compact --agent <id>` runs compaction on the latest session transcript for that agent (optional `--instructions <string>`, `--force` reserved). Uses the same core as `/compact` (summarize + prune); session is loaded from disk and workspace/model come from config and cwd. See [CLI memory](https://docs.openclaw.ai/cli/memory).
  - **Proactive auto-compaction:** In the embedded Pi run loop, if estimated session tokens ≥ 80% of the model context window before the next turn, OpenClaw compacts once and then proceeds, reducing context-overflow errors. If compaction reports "Already compacted" (or does not reduce the session), the loop proceeds to the turn instead of retrying indefinitely.
  - **/compact scope:** `/compact` is registered with `scope: "both"` and `nativeName: "compact"` so channels that support native UI (e.g. Telegram) can show a compact button as well as the slash command.

### Docker image, health checks, and helper shims

- **Container helper binaries (baked into Docker image)**
  - New `bin/` directory with:
    - `bin/docker-health`: safe health check for all containers that:
      - exits `127` if `docker` is not installed
      - handles the "no containers" case cleanly
      - prints `<container-name>: <status>` using `.State.Health.Status` when present, falling back to `.State.Status`
    - `bin/weather`: small weather wrapper for the gateway agent that:
      - uses `flock` on `/tmp/weather-tool.lock` to avoid thundering herd (multiple concurrent weather tool calls)
      - prefers `wttr.in` with a 2s timeout and falls back to Open-Meteo for Jefferson, GA (Phil’s node) when needed
    - `bin/himalaya`: Himalaya CLI v1.1.0 compatibility shim that:
      - resolves the real binary as `himalaya-real` when available (or `/usr/local/bin/himalaya` otherwise)
      - remaps `list` → `envelope list`, `read` → `message read`, and `envelope read` → `message read` while passing other commands through
  - Root `Dockerfile` copies `bin/` into `/usr/local/bin/` and marks the helper scripts executable so they are always available in containerized deployments (Fly, Render, GCP, etc.).

### Scheduler and cron reliability

- **Cron zombie scheduler + in-flight job persistence**
  - Hardening to prevent and recover from a stuck scheduler **without losing one-shot reminders**:
    - Re-arm timer in catch block when `onTimer` throws.
    - Re-arm on `cron list` / `cron status` when timer is dead (zombie recovery).
    - Watchdog timer (every 2.5 min) re-arms if main timer dies.
    - **Anti-zombie self-healing**: secondary check-in every 60s; if no timer tick completes within 60s (e.g. event loop blocked), the scheduler re-initializes (clear timer, re-arm) so the service does not stay "Active" with jobs frozen. Unit tests in `src/cron/service.anti-zombie.test.ts` cover re-init when idle and no false positive when a recent tick completed.
    - Per-job dynamic stuck threshold (`runningAtMs`) based on job timeout.
    - Stale `state.running` recovery when `onTimer` hangs.
    - **In-flight job persistence**: anti-zombie recovery scans for stale `runningAtMs` markers, clears them, and marks those jobs due again so mid-flight one-shot `--at` reminders are retried instead of silently dropped. Startup only clears obviously stale `runningAtMs` markers to avoid double-running fresh in-flight work.
    - Troubleshooting docs for "Cron stuck (zombie scheduler)" updated to describe anti-zombie recovery logs and in-flight job persistence.

### Plugin CLI command registration

- **Dynamic subcommand linkage**
  - Plugin-provided CLI commands (e.g. `openclaw foundry-openclaw`) were failing with "unknown command" despite the plugin being loaded. Plugin CLI registration runs in `run-main` before lazy subcli registration and before parse: `registerPluginCliCommands(program, loadConfig())` is invoked so plugin subcommands are on the root program in time. Built-in commands (e.g. `memory`) are registered during `buildProgram()`, so overlapping plugin commands are skipped and no duplicate-command error occurs. No manual binary edits are required; `openclaw <plugin-cmd>` works when the plugin is enabled and registers a CLI. See `src/cli/run-main.ts`, `src/plugins/cli.ts`, and tests in `src/plugins/cli.test.ts`, `src/cli/program/command-registry.test.ts`.

### Model / provider integrations

- **Ollama**
  - Support `OLLAMA_HOST` for cloud/remote discovery and requests (`8cb58d65d`). When `OLLAMA_HOST` is set, discovery uses a 15s timeout (vs 5s for local) to reduce timeouts on VPS/remote.
  - After merging upstream (openclaw#14131), both behaviors are preserved: (1) **Configured base URL** — when an explicit `baseUrl` is provided (e.g. via config or `explicitProviders.ollama.baseUrl`), it is used for discovery and the provider; (2) **OLLAMA_HOST fallback** — when no base URL is configured, `OLLAMA_HOST` (or the default localhost) is used. `resolveOllamaApiBase(configuredBaseUrl?)` and `buildOllamaProvider(configuredBaseUrl?)` in `src/agents/models-config.providers.ts` implement this; tests cover both “OLLAMA_HOST for provider baseUrl” and “preserve explicit ollama baseUrl on implicit provider injection”.

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
