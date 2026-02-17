# Fork-specific changes

Explicit listing of changes in this fork relative to upstream [OpenClaw](https://github.com/openclaw/openclaw). For sync procedure, see [.agent/workflows/update_clawdbot.md](.agent/workflows/update_clawdbot.md).

## ClawdBot-Next / prompt-engine integration

- **Agent system prompt** — Integrated [ClawdBot-Next](https://github.com/ClawdBot/ClawdBot-Next) prompt-engine:
  - `src/agents/prompt-engine/`: skills loader, triangulator, skill injector, system directives, types, clawd-matrix, data/skills.json, data/domain-map.json.
  - `src/agents/system-prompt.ts`: uses `SkillsLoader`, `Triangulator`, `SkillInjector`, `SYSTEM_DIRECTIVES`; `buildAgentSystemPrompt` is async and accepts optional `userPrompt` for triangulation. Skill selection is driven by `SkillsLoader.getSkillsForDomain(context.domain)` using domain-map.json (no hardcoded domain→skill mapping). OpenClaw-specific sections (safety, branding, `memoryCitationsMode`, sandbox) preserved.
  - `src/agents/pi-embedded-runner/system-prompt.ts`: passes `userPrompt` through to `buildAgentSystemPrompt` and awaits it.
- **Domain-map and JSON-driven routing** — Domain detection and skill selection are config-driven:
  - `data/domain-map.json`: defines per-domain `triggers` (keywords for rule-based routing) and `skills` (skill names to load), plus optional `global_defaults` applied to every domain. Same resolution order as skills.json (dist/data, then source).
  - Triangulator builds regex rules from `SkillsLoader.getDomainTriggers()` instead of hardcoded KEYWORD_RULES; adds a General fallback rule for greetings.
  - SkillsLoader exposes `loadDomainMap()`, `getDomainTriggers()`, and `getSkillsForDomain(domain)`; skill selection in the system prompt uses `getSkillsForDomain` exclusively.
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
  - Copy `src/agents/prompt-engine/data/skills.json` and `src/agents/prompt-engine/data/domain-map.json` to `dist/data/` and `dist/agents/prompt-engine/data/` during build via `scripts/copy-skills-data.ts` (tsdown does not copy non-TS assets; without this, the Skills Registry and domain map hit ENOENT at runtime). When the gateway runs as `node dist/index.js`, the loader resolves `dist/data/skills.json` and `dist/data/domain-map.json` first so it works with the bundled layout.
- **Build race (skills ENOENT) hardening**
  - Avoid empty-`dist/` window during `pnpm build`: (1) `tsdown.config.ts` sets `clean: false` so the output dir is not wiped and `dist/data/` persists; (2) gateway eager-loads `SkillsLoader.loadLibrary()` at boot and caches in RAM so cron/agent turns never read disk during a build; (3) loader retries on ENOENT for a short window. See [MAINTENANCE.md](docs/MAINTENANCE.md) “Build-phase race”.
- **Skills loader resolution**
  - Resolves `skills.json` in order: `dist/data/skills.json` (when `argv[1]` is `.../dist/index.js`), then same-dir `data/skills.json`, then `src/agents/prompt-engine/data/skills.json`. If the dist copy is missing, logs `Loaded skills from source path (dist copy missing)` and may retry; gateway boot preloads the library into a static singleton so the running process does not depend on disk after startup. `domain-map.json` uses the same path order (dist/data, then source); if missing, loader returns `{ domains: {} }` and the triangulator still has a General fallback.
- **Type/SDK fixes**
  - `SkillDefinition` includes optional `associated_domains` for parity with ClawdBot-Next. Skill selection in the system prompt uses `SkillsLoader.getSkillsForDomain(context.domain)` (domain-map–driven); no in-repo `selectSkillsForContext`; `skills.json` and `domain-map.json` are copied to dist during build.

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
  - New `scripts/docker-helpers/` directory (committed; `bin/` is gitignored) with:
    - `scripts/docker-helpers/docker-health`: safe health check for all containers that:
      - exits `127` if `docker` is not installed
      - handles the "no containers" case cleanly
      - prints `<container-name>: <status>` using `.State.Health.Status` when present, falling back to `.State.Status`
    - `scripts/docker-helpers/weather`: small weather wrapper for the gateway agent that:
      - uses `flock` on `/tmp/weather-tool.lock` to avoid thundering herd (multiple concurrent weather tool calls)
      - prefers `wttr.in` with a 2s timeout and falls back to Open-Meteo for Jefferson, GA (Phil’s node) when needed
    - `scripts/docker-helpers/himalaya`: Himalaya CLI v1.1.0 compatibility shim that:
      - resolves the real binary as `himalaya-real` when available (or `/usr/local/bin/himalaya` otherwise)
      - remaps `list` → `envelope list`, `read` → `message read`, and `envelope read` → `message read` while passing other commands through
  - Root `Dockerfile` copies `scripts/docker-helpers/` into `/usr/local/bin/` and marks the helper scripts executable so they are always available in containerized deployments (Fly, Render, GCP, etc.).

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
- **Cron "timer armed" log throttling**
  - When many cron API calls occur in a short window (e.g. control UI or many clients calling `cron.list` / `cron.status` / `cron.update`), each call invoked `armTimer()` and the debug log "cron: timer armed" was emitted every time, producing dozens or hundreds of lines per second. Throttling in `src/cron/service/timer.ts`: we only log when at least 1s has passed since the last log or when the next wake time/delay changed, so bursts produce at most one line per second while schedule changes are still visible. **Post-merge (Feb 2026):** Throttle tightened so we only log when `nextAt` or `delayMs` actually change; repeated `armTimer()` calls with the same schedule (e.g. polling every second) no longer produce a new log line, eliminating "timer armed" message looping.
- **Gateway lock (single-instance) documentation**
  - `docs/gateway/gateway-lock.md` updated to describe both the file lock (primary) and port bind (backstop), where the lock file lives, when the lock is skipped (`OPENCLAW_ALLOW_MULTI_GATEWAY=1` or tests), and an "Ensuring a single gateway" section so operators can avoid multiple gateways and the resulting cron log storm from multiple cron service instances.

### Plugin CLI command registration

- **Dynamic subcommand linkage**
  - Plugin-provided CLI commands (e.g. `openclaw foundry-openclaw`) were failing with "unknown command" despite the plugin being loaded. Plugin CLI registration runs in `run-main` before lazy subcli registration and before parse: `registerPluginCliCommands(program, loadConfig())` is invoked so plugin subcommands are on the root program in time. Built-in commands (e.g. `memory`) are registered during `buildProgram()`, so overlapping plugin commands are skipped and no duplicate-command error occurs. No manual binary edits are required; `openclaw <plugin-cmd>` works when the plugin is enabled and registers a CLI. See `src/cli/run-main.ts`, `src/plugins/cli.ts`, and tests in `src/plugins/cli.test.ts`, `src/cli/program/command-registry.test.ts`.

### Plugin API handler registration leak

- **Typed hooks accumulation on reload**
  - The Plugin API supports typed hooks (e.g. `before_tool_call`, `tool_result_persist`). On gateway restart, plugin reload, or hot-reload, new handlers were registered without clearing the previous registry’s typed hooks, so the count grew (e.g. 300+ handlers). Fix: the loader now clears the previous registry’s typed hooks before creating a new one. In `src/plugins/registry.ts`, `clearTypedHooks()` and `clearTypedHooksForPlugin(pluginId)` were added and returned from `createPluginRegistry()`. In `src/plugins/loader.ts`, the loader stores the current registry’s `clearTypedHooks` and invokes it at the start of the next full load (after `clearPluginCommands()`), so the registry being replaced is cleared before a fresh one is built and passed to the global hook runner.

### Model / provider integrations

- **Ollama**
  - Support `OLLAMA_HOST` for cloud/remote discovery and requests (`8cb58d65d`). When `OLLAMA_HOST` is set, discovery uses a 15s timeout (vs 5s for local) to reduce timeouts on VPS/remote.
  - After merging upstream (openclaw#14131), both behaviors are preserved: (1) **Configured base URL** — when an explicit `baseUrl` is provided (e.g. via config or `explicitProviders.ollama.baseUrl`), it is used for discovery and the provider; (2) **OLLAMA_HOST fallback** — when no base URL is configured, `OLLAMA_HOST` (or the default localhost) is used. `resolveOllamaApiBase(configuredBaseUrl?)` and `buildOllamaProvider(configuredBaseUrl?)` in `src/agents/models-config.providers.ts` implement this; tests cover both “OLLAMA_HOST for provider baseUrl” and “preserve explicit ollama baseUrl on implicit provider injection”.
  - **Per-agent models.json safety** — `update.run` now clears `~/.openclaw/agents/*/agent/models.json` after successful updates so any hallucinated or stale model registries are discarded and regenerated from the canonical config on next boot.

### Foundry / Cursor integration hardening

Operational checklist when running this fork with [OpenClaw-Foundry](https://github.com/openclaw/openclaw-foundry): [docs/MAINTENANCE.md](docs/MAINTENANCE.md#openclaw-foundry-integration).

- **Hooks loader (ESM + CJS)** — Hook handlers from managed dir (`~/.openclaw/hooks/`), workspace, bundled, or plugins (e.g. Foundry) can be CommonJS. The loader previously used only dynamic `import()`, so CJS modules threw “module is not defined in ES module scope” (e.g. `sessions-notfound-auto-retry`). Fix: shared `src/hooks/load-module.ts` tries ESM import first; on that error, falls back to `createRequire(import.meta.url)(filePath)`. Both the internal hooks loader (`src/hooks/loader.ts`) and the plugin hooks loader (`src/hooks/plugin-hooks.ts`) use this helper, so CJS hooks load whether they are discovered as internal or plugin hooks. Handler resolution supports `module.exports = function` as the default export. **Post-merge (Feb 2026):** `isCjsInEsmError` also treats "require is not defined in ES module scope" as CJS load failure so hooks that use `require()` but are loaded as ESM get the require fallback. For `.js`, `.cjs`, and `.ts` handler files, the loader now tries `require()` first so CJS hooks (e.g. `system-state-updater`) load without being parsed as ESM and never hit that error; if `require()` throws "require() of ES Module not supported", it falls back to `import()`. For `.ts` (and .tsx/.mts/.cts), when Node’s `require()` fails (e.g. "Unknown file extension"), the loader uses **jiti** to load the file so the hook runs with `require` in scope (avoids "require is not defined" after merges that changed how hooks are loaded). If jiti is unavailable or fails, it falls back to `import()`. Tests in `src/hooks/load-module.test.ts` cover both "module is not defined" and "require is not defined".
- **Hooks loader (object-with-.handle)** — Foundry and other generators sometimes export a default that is an object with a `.handle(ctx)` method instead of a bare function. The loader now accepts that shape: `getHandlerFromModule` in `src/hooks/load-module.ts` treats a default export that is an object with a function `.handle` as valid and wraps it so `(event) => obj.handle(event.context ?? {})` is registered. This avoids "Handler 'default' is not a function" when hooks use the object style; no manual wrapper export is required in the hook file. Tests in `src/hooks/load-module.test.ts` cover function default, CJS mod-as-function, and object-with-handle.
- **Tool group tightening for agents**
  - `group:fs` now expands to `read` + `apply_patch` only. Direct `write`/`edit` are no longer part of the global fs group and must be granted explicitly on a per-agent basis (for example, to a dedicated analyst workspace) instead of every agent inheriting broad write access.
  - Gateway docs and examples have been updated so `tools.profile: "coding"` plus `group:fs` describe read + structured patch access, matching the new behavior.
- **Config template guidance**
  - The default `openclaw.json` example under `docs/gateway/configuration-examples.md` now recommends granting global `exec`/`process` + `group:fs` only, with a comment pointing operators toward per-agent tool grants for high-privilege writers.
  - `.env.example` documents `GATEWAY_BOOTSTRAP_TIMEOUT=120000` as the recommended baseline when running heavy Foundry-style plugin stacks so cold-start SIGKILLs are less likely.
- **Foundry-side config writes (external repo)**
  - When updating the OpenClaw-Foundry extension, ensure its `foundry_write_extension` (or equivalent) performs a pre-flight check before committing any `models.providers` or provider entries into `openclaw.json`: for each new provider, verify the corresponding API key/token environment variables are present, and abort with a clear error if they are not. This keeps the gateway from booting into an invalid provider config.

### Discord typing and message hooks

- **Typing on message receive** — The Discord monitor now sends a typing indicator as soon as a non-empty message is accepted for processing (in addition to the existing typing on reply start). Implemented in `src/discord/monitor/message-handler.process.ts` via `sendTyping({ client, channelId: message.channelId })` right after the empty-text check.
- **Internal hook events `message:received` and `message:sent`** — New event type `"message"` added to the internal hook system (`src/hooks/internal-hooks.ts`) with:
  - **`message:received`**: fired at the start of Discord message processing with context `channel`, `senderId`, `channelId`, `messageId`, `messageText`. `messageId` is required so downstream hooks (e.g. `discord-thinking-start`) can pass the Discord message id into reply/follow-up calls; omitting it caused Discord API to reject replies with HTTP 400 Bad Request. Set in `src/discord/monitor/message-handler.process.ts`; `MessageReceivedHookEvent` context type in `src/hooks/internal-hooks.ts` includes optional `messageId`.
  - **`message:sent`**: fired after each Discord reply is delivered with context `channel`, `sessionId`, `replyText`.
  - Handlers can register for `"message"`, `"message:received"`, or `"message:sent"` as with other hook types. Telegram can be wired similarly in `src/telegram/bot-message-dispatch.ts` and delivery if needed.

### Discord gateway stability (Phase 2)

- **Reconnect ceiling and supervisor loop**
  - Discord gateway reconnects are now effectively unbounded: `createDiscordGatewayPlugin` sets `reconnect: { maxAttempts: Infinity }` in `src/discord/monitor/gateway-plugin.ts` so Carbon’s exponential backoff keeps running instead of exhausting after 50 attempts.
  - A supervisor wrapper `monitorDiscordProviderWithSupervisor` in `src/discord/monitor/provider.ts` (exported via `src/discord/monitor.ts` and wired into `src/plugins/runtime/index.ts`) restarts the Discord monitor when it exits with `"Max reconnect attempts"` or `"Fatal Gateway error"`, using exponential backoff (30s → 60s → 120s, capped at 5min) and respecting the gateway’s `abortSignal` at every step.
  - Supervisor restarts are logged via the `discord/supervisor` subsystem logger so “Discord went deaf, but gateway stayed up” is visible in logs along with backoff timing and attempt count.
- **Connection health watchdog**
  - The Discord monitor now tracks a `lastSuccessfulHeartbeat` timestamp using gateway `metrics` events and runs a periodic watchdog timer (every 2 minutes) inside `monitorDiscordProvider`.
  - When no metrics/heartbeat activity is observed for >5 minutes, the monitor logs a warning (`discord: gateway heartbeat stale for <N>s (no metrics events)`), giving an early signal for stalled or zombie gateway connections without changing shutdown semantics.
- **Empty payload validation (HTTP 400 fix)**
  - Fixed a bug where empty Discord message payloads could be sent, resulting in HTTP 400 Bad Request errors. Added validation in `sendDiscordText` to ensure payloads always have at least one valid field (content, embeds, files, sticker_ids, or components) before sending to Discord.
  - The validation catches edge cases where payloads become empty after processing (e.g., when v2 components are present but invalid, or when text becomes empty after chunking/processing). The existing `sendDiscordText` check for empty text provides the primary guard, with payload validation as a safety net.
  - Tests in `src/discord/send.sends-basic-channel-messages.test.ts` verify that empty payloads are rejected and that files can be sent without content.
- **Tests**
  - `src/discord/monitor/provider.proxy.test.ts` asserts that the gateway plugin’s `reconnect.maxAttempts` is `Infinity` and keeps covering proxy behavior.
  - `src/discord/monitor/provider.supervisor.test.ts` verifies that `monitorDiscordProviderWithSupervisor` returns immediately when the provided `abortSignal` is already aborted, ensuring the supervisor respects shutdown and does not spin up a new Discord session during gateway teardown.

### Upstream merge (Feb 2026) and session path fix

- **Merge from openclaw/main** — Integrated 113 upstream commits (through early Feb 2026). Resolved 9 conflicts while keeping fork behavior: labeler uses `github.token` (no App) in label/label-issues jobs; stderr in tool errors + `after_tool_call` on errors in `pi-tool-definition-adapter.ts`; upstream safe skill sync dest + fork `baseDir` check in `skills/workspace.ts`; async `buildAgentSystemPrompt` tests in `system-prompt.test.ts`; fork `getLatestSessionTranscriptForAgent` plus upstream path validation/APIs in `config/sessions/paths.ts`; both proactive-compaction and upstream promptTokens test in `run.overflow-compaction.test.ts`; `/compact` `scope: "both"` in `commands-registry.data.ts`. Discord channel-fetch test expectation updated for upstream role-based routing.
- **Session file path resolution** — Upstream added strict validation in `resolvePathWithinSessionsDir` (“Session file path must be within sessions directory”). When the reply flow called `resolveSessionFilePath` without `agentId`, the default agent’s sessions dir was used; sessions for other agents (e.g. Discord `analyst`) could have stored absolute `sessionFile` paths, causing the check to throw. Fix: (1) pass `{ agentId }` from `runPreparedReply` into `resolveSessionFilePath` in `src/auto-reply/reply/get-reply-run.ts` so the sessions dir matches the session’s agent; (2) in `resolveSessionFilePath`, if the stored `sessionFile` would escape the sessions dir (legacy absolute path or wrong agent), fall back to the path derived from `sessionId` under the same dir instead of throwing.

- _(Add further customizations, fixes, or config here as you make them.)_

## Phase 5: Upstream merge strategy and fork hygiene

- **5a. Fork isolation** — Fork-specific logic is kept in dedicated modules where possible: `src/agents/prompt-engine/` (skills loader, triangulator, injector, system directives) and config-gated paths (e.g. prompt-engine integration in `src/agents/system-prompt.ts`). See "ClawdBot-Next / prompt-engine integration" and conflict patterns in [.agent/workflows/update_clawdbot.md](.agent/workflows/update_clawdbot.md).
- **5b. Automated upstream sync testing** — A CI workflow runs **daily** (`.github/workflows/upstream-sync-test.yml`): fetches `openclaw/openclaw` `main`, attempts a merge into a temporary branch, runs `pnpm build && pnpm test`. **“Opens an issue if conflicts or failures are detected”** means: when the merge hits conflicts or when build/test fails, the workflow creates a new GitHub issue in this repo (title e.g. “Upstream sync test failed — YYYY-MM-DD”, body with the reason, **list of conflicted files** when applicable, and a link to the workflow run). You get notified without watching the Actions tab; bring the issue URL into Cursor (or your IDE) to analyze and fix, using the workflow run link for full logs; the workflow does not merge or push for you. **Preview:** each daily run writes an **upstream preview** (incoming commit list + CHANGELOG diff) to the workflow run’s **Job summary**. When the merge **fails**, the workflow also identifies **clean vs conflicted commits** (binary search): it reports how many upstream commits merge cleanly and how many at the tip introduce the conflict(s), and lists those commits in the issue body and in the “Identify clean vs conflicted commit range” step summary. **Conflict resolution:** run `git fetch upstream && git merge upstream/main` locally so conflicts appear in your workspace; the issue lists the conflicted files. See [.agent/workflows/update_clawdbot.md](.agent/workflows/update_clawdbot.md).
- **5c. Contributing generic improvements upstream** — Deferred; not part of the current Phase 5 implementation.

## Workflow / tooling

- **Sync workflow** — [.agent/workflows/update_clawdbot.md](.agent/workflows/update_clawdbot.md): steps for rebasing/merging from upstream (ClawdBot-Next and OpenClaw), conflict patterns, prompt-engine merge notes, rebuild and verify steps.
- Push policy: only to this fork; never push to ClawdBot-Next or OpenClaw upstream.

## Commit history (fork-only)

Commits on this fork’s `main` that are not in upstream OpenClaw (oldest first). Regenerate with: `git log upstream/main..origin/main --oneline --no-merges`. After the Feb 2026 upstream merge, fork-only commits include the merge resolution and the session path fix (pass `agentId` into `resolveSessionFilePath`, defensive fallback when stored path escapes sessions dir).

| Commit      | Description                                                                             |
| ----------- | --------------------------------------------------------------------------------------- |
| `b840d2be4` | Integrate ClawdBot-Next prompt-engine into system prompt                                |
| `31f034440` | Docs: add push policy to update_clawdbot workflow (push only to fork)                   |
| `ffe83456b` | fix: type SkillLibrary in selectSkillsForContext (fix build:plugin-sdk:dts)             |
| `8cb58d65d` | Ollama: support OLLAMA_HOST for cloud/remote discovery and requests                     |
| `394341893` | Agent loop-prevention: one config/restart/cron per request, report and ask before retry |
| `9a58bb654` | README: add fork notice, ClawdBot-Next integration, and from-source clone note          |
| `764bd1757` | prompt-engine: integrate ClawdBot-Next domain-map and JSON-driven triangulation         |
