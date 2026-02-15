# OpenClaw Developer Reference

> Practical reference for making code changes safely. Load before PRs, bug fixes, or refactoring.
> Designed for both human contributors and AI agents/tools.

---

## 1. Module Dependency Map

### Hierarchy (Level 0 = most depended upon)

| Level | Module        | Imports From                                                                    | Imported By                                | Risk        |
| ----- | ------------- | ------------------------------------------------------------------------------- | ------------------------------------------ | ----------- |
| 0     | `config/`     | `channels/registry`, `infra/`, `logging/`, `agents/defaults`                    | **Everything**                             | 🔴 CRITICAL |
| 0     | `shared/`     | `compat/`                                                                       | Many modules (pure types/constants)        | 🟡          |
| 1     | `infra/`      | `config/`, `logging/`, `process/`                                               | 400+ imports                               | 🔴 CRITICAL |
| 1     | `logging/`    | `config/`                                                                       | Most modules                               | 🟡          |
| 1     | `process/`    | `logging/`                                                                      | `infra/`, `agents/`, `hooks/`              | 🟡          |
| 2     | `channels/`   | `config/`, `infra/`, `plugins/`, `auto-reply/`                                  | `agents/`, `routing/`, `gateway/`          | 🔴 HIGH     |
| 2     | `routing/`    | `config/`, `sessions/`, `agents/agent-scope`, `channels/`                       | `gateway/`, `auto-reply/`, `cron/`, `web/` | 🔴 HIGH     |
| 2     | `sessions/`   | `config/`, `channels/`, `auto-reply/thinking`                                   | `routing/`, `gateway/`, `agents/`          | 🟡          |
| 3     | `agents/`     | `config/`, `routing/`, `sessions/`, `hooks/`, `channels/`, `infra/`, `plugins/` | 28+ modules                                | 🔴 CRITICAL |
| 4     | `auto-reply/` | `agents/`, `config/`, `channels/`, `routing/`, `tts/`, `media-understanding/`   | `gateway/`, channel monitors               | 🔴 HIGH     |
| 5     | `memory/`     | `config/`, `agents/`, `sessions/`, `logging/`                                   | `agents/tools/`, `gateway/`                | 🟡          |
| 5     | `cron/`       | `config/`, `agents/`, `routing/`, `infra/`, `auto-reply/`                       | `gateway/`, `agents/tools/`                | 🟡          |
| 5     | `hooks/`      | `config/`, `agents/`, `plugins/`, `markdown/`, `process/`                       | `gateway/`, `agents/`, `plugins/`          | 🟡          |
| 5     | `plugins/`    | `config/`, `agents/`, `channels/`, `hooks/`, `infra/`, `logging/`               | `gateway/`, `channels/`, `cli/`            | 🟡          |
| 5     | `security/`   | `agents/`, `browser/`, `channels/`, `config/`, `gateway/`, `infra/`, `plugins/` | `cli/`, `gateway/`, `acp/`                 | 🟢          |
| 5     | `browser/`    | `config/`, `infra/`                                                             | `agents/tools/`, `gateway/`, `cli/`        | 🟢          |
| 5     | `media/`      | `config/`, `infra/`                                                             | `agents/`, `auto-reply/`, channels         | 🟢          |
| 5     | `tts/`        | `agents/model-auth`                                                             | `auto-reply/`, `gateway/`                  | 🟢          |
| 6     | `gateway/`    | Almost everything                                                               | `cli/`, `commands/`, `daemon/`, `acp/`     | 🔴 HIGH     |
| 7     | `cli/`        | `config/`, `commands/`, `infra/`, `agents/`, `plugins/`                         | Package entry point                        | 🟡          |
| 7     | `commands/`   | `config/`, `cli/`, `infra/`, `agents/`, `channels/`, `daemon/`                  | `cli/`                                     | 🟡          |

Channel implementations (`telegram/`, `discord/`, `slack/`, `signal/`, `line/`, `imessage/`, `web/`) are leaf modules with 🟢 risk.

### High-Blast-Radius Files

| File                       | What It Exports                                                    |
| -------------------------- | ------------------------------------------------------------------ |
| `config/config.ts`         | `loadConfig()`, `OpenClawConfig`, `clearConfigCache()`             |
| `config/types.ts`          | All config type re-exports                                         |
| `config/paths.ts`          | `resolveStateDir()`, `resolveConfigPath()`, `resolveGatewayPort()` |
| `config/sessions.ts`       | Session store CRUD                                                 |
| `infra/errors.ts`          | Error utilities                                                    |
| `infra/json-file.ts`       | `loadJsonFile()`, `saveJsonFile()`                                 |
| `agents/agent-scope.ts`    | `resolveDefaultAgentId()`, `resolveAgentWorkspaceDir()`            |
| `agents/defaults.ts`       | `DEFAULT_PROVIDER`, `DEFAULT_MODEL`                                |
| `channels/registry.ts`     | `CHAT_CHANNEL_ORDER`, `normalizeChatChannelId()`                   |
| `routing/session-key.ts`   | `buildAgentPeerSessionKey()`, `normalizeAgentId()`                 |
| `auto-reply/templating.ts` | `MsgContext`, `TemplateContext` types                              |
| `auto-reply/thinking.ts`   | `ThinkLevel`, `VerboseLevel`, `normalizeVerboseLevel()`            |
| `logging/subsystem.ts`     | `createSubsystemLogger()`                                          |

---

## 2. Critical Paths (Don't Break These)

### Message Lifecycle: Inbound → Response

```
Channel SDK event (grammY/Carbon/Bolt/SSE/RPC)
→ src/<channel>/bot-handlers.ts or monitor/*.ts
→ src/<channel>/bot-message-context.ts         # normalize to MsgContext
→ src/auto-reply/dispatch.ts                   # dispatchInboundMessage()
→ src/routing/resolve-route.ts                 # resolveAgentRoute() → {agentId, sessionKey}
→ src/auto-reply/reply/dispatch-from-config.ts # dispatchReplyFromConfig()
→ src/auto-reply/reply/get-reply.ts            # getReplyFromConfig() — MAIN ORCHESTRATOR
  ├─ media-understanding/apply.ts
  ├─ command-auth.ts
  ├─ reply/session.ts                          # initSessionState()
  ├─ reply/get-reply-directives.ts             # parse /model, /think, etc.
  ├─ reply/get-reply-inline-actions.ts         # handle /new, /status, etc.
  └─ reply/get-reply-run.ts                    # runPreparedReply()
→ src/auto-reply/reply/agent-runner.ts         # runReplyAgent()
→ src/auto-reply/reply/agent-runner-execution.ts # runAgentTurnWithFallback()
→ src/agents/pi-embedded-runner/run/           # runEmbeddedPiAgent()
  ├─ system-prompt.ts                          # build system prompt
  ├─ model-selection.ts                        # resolve model + auth
  ├─ pi-tools.ts                               # register tools
  └─ agents/pi-embedded-subscribe.ts           # process LLM stream
→ src/auto-reply/reply/block-reply-pipeline.ts # coalesce blocks
→ src/auto-reply/reply/reply-dispatcher.ts     # buffer + human delay
→ src/channels/plugins/outbound/<channel>.ts   # format + chunk
→ src/<channel>/send.ts                        # API call
```

### Tool Execution: Tool Call → Result

```
LLM stream → agents/pi-embedded-subscribe.handlers.tools.ts  # extract tool call
→ agents/pi-tools.ts                                          # registry lookup
→ agents/pi-tools.before-tool-call.ts                         # pre-call hooks
→ agents/tool-policy-pipeline.ts                              # allow/deny/ask
  └─ agents/tool-policy.ts + pi-tools.policy.ts
→ Tool implementation (e.g. agents/bash-tools.exec.ts)
  └─ process/exec.ts → runCommandWithTimeout()
  └─ gateway/exec-approval-manager.ts (if approval needed)
→ agents/pi-embedded-runner/tool-result-truncation.ts         # truncate if large
→ Result returned to LLM stream → continues generation
```

### Config Loading: JSON → Validated Object

```
config/paths.ts → resolveConfigPath()
→ config/io.ts → readFileSync (JSON5)
→ config/includes.ts → resolve $include directives
→ config/env-substitution.ts → expand ${ENV_VAR}
→ config/validation.ts → Zod parse against OpenClawSchema
→ config/legacy-migrate.ts → auto-migrate old config
→ config/defaults.ts → apply*Defaults() (models, agents, sessions, logging, compaction, pruning)
→ config/runtime-overrides.ts → env var overrides
→ config/normalize-paths.ts → normalize paths
→ Cache in memory (clearConfigCache() to invalidate)
```

### Hook Loading: Boot → Registered

```
gateway/server-startup.ts → loadInternalHooks()
→ hooks/workspace.ts → loadWorkspaceHookEntries()
  └─ Scan: extraDirs → bundled → managed → workspace (later overrides)
  └─ hooks/frontmatter.ts → parse HOOK.md metadata
  └─ hooks/config.ts → shouldIncludeHook() (OS/binary/config checks)
→ hooks/loader.ts → dynamic import() with buildImportUrl()
→ hooks/internal-hooks.ts → registerInternalHook()
```

### Plugin Loading: Discovery → Registered

```
gateway/server-plugins.ts
→ plugins/discovery.ts → discoverOpenClawPlugins()
  └─ Scan: extensions/ → ~/.openclaw/plugins/ → workspace plugins/ → config paths
→ plugins/manifest.ts → parse openclaw.plugin.json
→ plugins/loader.ts → loadOpenClawPlugins()
  └─ jiti dynamic import for each plugin module
  └─ Plugin exports definePlugin() → {tools, hooks, channels, providers, httpRoutes, services}
→ plugins/registry.ts → PluginRegistry singleton
→ plugins/runtime.ts → setActivePluginRegistry()
```

---

## 3. Change Impact Matrix

| If You Change...                 | You MUST Also Check/Test...                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/zod-schema*.ts`          | ALL config validation tests, `config/defaults.ts`, JSON schema generation (`config/schema.ts`), every module that reads the changed config key |
| `config/types*.ts`               | Every file that imports the changed type (grep!), Zod schema must match                                                                        |
| `config/io.ts`                   | Config loading, `$include`, env substitution, backup rotation, migration                                                                       |
| `config/sessions/store.ts`       | Session CRUD in gateway, agent runner, directive handling                                                                                      |
| `routing/resolve-route.ts`       | All channel monitors, gateway session resolution, cron delivery                                                                                |
| `routing/session-key.ts`         | Session key parsing everywhere, cron sessions, subagent sessions                                                                               |
| `agents/pi-tools.ts`             | ALL tool tests, tool policy, tool display, sandbox tool policy                                                                                 |
| `agents/pi-embedded-runner/run/` | The entire agent execution path, fallback, compaction, streaming                                                                               |
| `agents/system-prompt.ts`        | Agent behavior changes — test with actual LLM calls                                                                                            |
| `agents/model-selection.ts`      | Model resolution across all agents, directives, cron, subagents                                                                                |
| `agents/tool-policy*.ts`         | Tool access for all tools, sandbox, subagent restrictions                                                                                      |
| `auto-reply/dispatch.ts`         | All channel inbound paths                                                                                                                      |
| `auto-reply/reply/get-reply.ts`  | The entire reply pipeline — most impactful single file                                                                                         |
| `auto-reply/templating.ts`       | `MsgContext` type used by 15+ files                                                                                                            |
| `auto-reply/thinking.ts`         | `ThinkLevel`/`VerboseLevel` used across agents, directives, sessions                                                                           |
| `channels/plugins/types*.ts`     | ALL channel implementations, plugin SDK                                                                                                        |
| `channels/registry.ts`           | Channel normalization, routing, dock, all channel references                                                                                   |
| `gateway/server.impl.ts`         | Gateway startup, all server subsystems                                                                                                         |
| `gateway/protocol/schema/*.ts`   | WS protocol compat, CLI client, TUI                                                                                                            |
| `hooks/internal-hooks.ts`        | All hook handlers, gateway startup, session-memory hook                                                                                        |
| `plugins/loader.ts`              | ALL plugins, gateway startup                                                                                                                   |
| `infra/json-file.ts`             | Cron store, auth profiles, session store, device auth                                                                                          |
| `security/external-content.ts`   | Prompt injection defense, web_fetch, link understanding                                                                                        |
| `logging/subsystem.ts`           | Every module that creates loggers                                                                                                              |
| Any `index.ts` barrel            | All consumers of that module's exports                                                                                                         |

### Cross-Module Side Effects (Non-Obvious)

- **`agents/` ↔ `auto-reply/`**: Bidirectional dependency by design. Changes to agent run result types break reply delivery.
- **`config/sessions/` → `routing/` → `gateway/`**: Session key format changes ripple to route resolution and gateway session management.
- **`channels/dock.ts`**: Returns channel metadata without importing heavy channel code. If you change a channel's capabilities, update the dock too.
- **`auto-reply/thinking.ts`**: `VerboseLevel` is used by `sessions/level-overrides.ts` — changing enum values breaks session persistence.
- **`infra/outbound/deliver.ts`**: Used by both cron delivery AND channel tool message sending. Changes affect both paths.

---

## 4. Testing Guide

### Running Tests

```bash
# Full suite
pnpm vitest run

# Single module
pnpm vitest run src/config/

# Single file
pnpm vitest run src/config/io.test.ts

# Watch mode
pnpm vitest src/config/io.test.ts

# With coverage
pnpm vitest run --coverage
```

### Test Framework: Vitest

- Config: `vitest.config.ts` at project root
- Mocking: `vi.mock()`, `vi.fn()`, `vi.spyOn()`
- Assertions: `expect()` with Vitest matchers

### Test Patterns

| Pattern      | Example                                |
| ------------ | -------------------------------------- |
| Unit test    | `src/config/io.test.ts`                |
| E2E test     | `src/cli/program.smoke.e2e.test.ts`    |
| Test harness | `src/cron/service.test-harness.ts`     |
| Test helpers | `src/test-helpers/`, `src/test-utils/` |
| Mock file    | `src/cron/isolated-agent.mocks.ts`     |

### Test Helpers

- `src/test-helpers/` — Shared test utilities
- `src/test-utils/` — Additional test utilities
- `src/config/test-helpers.ts` — Config-specific test helpers
- `src/cron/service.test-harness.ts` — Cron service test fixture
- `src/cron/isolated-agent.test-harness.ts` — Isolated agent test fixture
- `src/memory/embedding-manager.test-harness.ts` — Embedding test fixture

### CI Pipeline

- **Build**: `pnpm build` (TypeScript compilation)
- **Lint**: `pnpm lint` (typescript-eslint, type-aware)
- **Format**: `pnpm format:check`
- **Tests**: `pnpm vitest run`

---

## 5. Pre-PR Checklist

```
□ pnpm lint                         # Full project, zero NEW errors
□ pnpm vitest run                   # All related test files pass
□ pnpm format:fix                   # No formatting issues
□ git diff --stat                   # Review what you're committing
□ grep all callers                  # If changing function signatures
□ Squash fix-on-fix commits         # Clean logical commits only
```

### Commit Message Conventions

- `feat:` — New feature
- `fix:` — Bug fix
- `perf:` — Performance improvement
- `refactor:` — Code restructuring
- `test:` — Test additions/changes
- `docs:` — Documentation

### Common Pitfalls

1. **Never call `loadConfig()` in render/hot paths** — it does sync `fs.readFileSync`. Thread config through params.
2. **Verify function is actually `async` before adding `await`** — causes `await-thenable` lint errors.
3. **Removing `async` from exported functions is BREAKING** — changes return type from `Promise<T>` to `T`. All `await` callers break.
4. **Primary operations must throw; only convenience ops get try/catch** — don't swallow errors on critical paths.
5. **Guard numeric comparisons against NaN** — use `Number.isFinite()` before `>` / `<`.
6. **Normalize paths before string comparison** — `path.resolve()` before `===`.
7. **Derive context from parameters, not global state** — use explicit paths, not env var fallbacks.
8. **Run FULL `pnpm lint` before every push** — not just changed files. Type-aware linting catches cross-file issues.

---

## 6. Configuration Reference

### Root Config (`openclaw.json` — JSON5)

| Section             | Type File                          | Zod Schema                         |
| ------------------- | ---------------------------------- | ---------------------------------- |
| `agents`            | `types.agents.ts`                  | `zod-schema.agents.ts`             |
| `agents.defaults`   | `types.agent-defaults.ts`          | `zod-schema.agent-defaults.ts`     |
| `bindings[]`        | `types.agents.ts` (`AgentBinding`) | `zod-schema.agents.ts`             |
| `session`           | `types.base.ts` (`SessionConfig`)  | `zod-schema.session.ts`            |
| `gateway`           | `types.gateway.ts`                 | `zod-schema.ts`                    |
| `models`            | `types.models.ts`                  | `zod-schema.ts`                    |
| `authProfiles`      | `types.auth.ts`                    | `zod-schema.ts`                    |
| `tools`             | `types.tools.ts`                   | `zod-schema.agent-runtime.ts`      |
| `channels.telegram` | `types.telegram.ts`                | `zod-schema.providers.ts`          |
| `channels.discord`  | `types.discord.ts`                 | `zod-schema.providers.ts`          |
| `channels.slack`    | `types.slack.ts`                   | `zod-schema.providers.ts`          |
| `channels.signal`   | `types.signal.ts`                  | `zod-schema.providers.ts`          |
| `channels.whatsapp` | `types.whatsapp.ts`                | `zod-schema.providers-whatsapp.ts` |
| `channels.imessage` | `types.imessage.ts`                | `zod-schema.providers.ts`          |
| `hooks`             | `types.hooks.ts`                   | `zod-schema.hooks.ts`              |
| `cron`              | `types.cron.ts`                    | `zod-schema.ts`                    |
| `memory`            | `types.memory.ts`                  | `zod-schema.ts`                    |
| `messages`          | `types.messages.ts`                | `zod-schema.ts`                    |
| `approvals`         | `types.approvals.ts`               | `zod-schema.approvals.ts`          |
| `sandbox`           | `types.sandbox.ts`                 | `zod-schema.ts`                    |
| `logging`           | `types.base.ts`                    | `zod-schema.ts`                    |
| `plugins`           | `types.plugins.ts`                 | `zod-schema.ts`                    |
| `browser`           | `types.browser.ts`                 | `zod-schema.ts`                    |

All type files are in `src/config/`, all Zod schemas in `src/config/`.

### How to Add a New Config Key

1. Add type to appropriate `config/types.*.ts` file
2. Add Zod schema to appropriate `config/zod-schema.*.ts` file — type and schema MUST match
3. Add default in `config/defaults.ts` if applicable
4. Update `config/schema.hints.ts` if it needs UI labels
5. Add test in `config/config.*.test.ts`
6. If migrating from old format: add rule in `config/legacy.migrations.part-*.ts`

---

## 7. Key Types Quick Reference

| Type                          | File                                 | Usage                                                          |
| ----------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| `OpenClawConfig`              | `config/types.openclaw.ts`           | Root config — used everywhere                                  |
| `AgentConfig`                 | `config/types.agents.ts`             | Per-agent config                                               |
| `AgentBinding`                | `config/types.agents.ts`             | Channel→agent binding                                          |
| `SessionEntry`                | `config/sessions/types.ts`           | Persistent session state                                       |
| `MsgContext`                  | `auto-reply/templating.ts`           | Inbound message context                                        |
| `ReplyPayload`                | `auto-reply/types.ts`                | Reply output (text, media, replyTo)                            |
| `ChannelPlugin`               | `channels/plugins/types.plugin.ts`   | Channel plugin contract                                        |
| `ChannelId` / `ChatChannelId` | `channels/plugins/types.core.ts`     | Channel identifier types                                       |
| `ChatType`                    | `channels/chat-type.ts`              | `"direct" \| "group" \| "channel"`                             |
| `ThinkLevel`                  | `auto-reply/thinking.ts`             | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"` |
| `VerboseLevel`                | `auto-reply/thinking.ts`             | `"off" \| "on" \| "full"`                                      |
| `ToolPolicyAction`            | `agents/tool-policy.ts`              | `"allow" \| "deny" \| "ask"`                                   |
| `EmbeddedPiRunResult`         | `agents/pi-embedded-runner/types.ts` | Agent run result                                               |
| `ResolvedAgentRoute`          | `routing/resolve-route.ts`           | Routing result                                                 |
| `InputProvenance`             | `sessions/input-provenance.ts`       | Message origin tracking                                        |
| `HookSource`                  | `hooks/types.ts`                     | Hook source discriminator                                      |
| `CronJob`                     | `cron/types.ts`                      | Scheduled job definition                                       |
| `MemorySearchResult`          | `memory/types.ts`                    | Search result from memory index                                |

---

## 8. File Naming Conventions

### Within Modules

```
src/<module>/
├── index.ts                    # Barrel re-exports (public API)
├── types.ts                    # Type definitions
├── *.ts                        # Implementation files
├── *.test.ts                   # Co-located unit tests
├── *.e2e.test.ts               # End-to-end tests
├── *.test-harness.ts           # Reusable test fixtures
├── *.mocks.ts                  # Test mocks
```

### Naming Patterns

| Pattern             | Meaning                             | Example                     |
| ------------------- | ----------------------------------- | --------------------------- |
| `*.test.ts`         | Unit test                           | `io.test.ts`                |
| `*.e2e.test.ts`     | End-to-end test                     | `program.smoke.e2e.test.ts` |
| `*.test-harness.ts` | Reusable test fixture               | `service.test-harness.ts`   |
| `*.mocks.ts`        | Test mock definitions               | `isolated-agent.mocks.ts`   |
| `*.impl.ts`         | Implementation (when barrel exists) | `auto-reply.impl.ts`        |
| `zod-schema.*.ts`   | Zod validation schema               | `zod-schema.agents.ts`      |
| `types.*.ts`        | Domain-specific types               | `types.telegram.ts`         |

### Where to Put New Files

| Adding a...            | Put it in...                                                           |
| ---------------------- | ---------------------------------------------------------------------- |
| New tool               | `src/agents/tools/<tool-name>.ts` + register in `openclaw-tools.ts`    |
| New channel            | `src/<channel>/` + `extensions/<channel>/` for plugin                  |
| New CLI command        | `src/cli/<command>-cli.ts` + `src/commands/<command>.ts`               |
| New config type        | `src/config/types.<section>.ts` + `src/config/zod-schema.<section>.ts` |
| New hook               | `src/hooks/bundled/<hook-name>/handler.ts` + `HOOK.md`                 |
| New gateway RPC method | `src/gateway/server-methods/<method>.ts`                               |
| New test               | Co-locate with source: `src/<module>/<file>.test.ts`                   |

---

## 9. Gotchas & Landmines

### Things That Look Simple But Aren't

1. **`loadConfig()` is synchronous with caching** — First call reads disk (sync `fs.readFileSync`). Subsequent calls return cached. `clearConfigCache()` to invalidate. NEVER call in hot paths.

2. **Route resolution uses `WeakMap` cache on config object** — `routing/resolve-route.ts` caches bindings evaluation on the config object itself. If you spread/clone config, the cache misses.

3. **Session keys are hierarchical** — Format: `agent:<id>:<channel>:<kind>:<peerId>[:thread:<threadId>]`. Functions like `isSubagentSessionKey()`, `isCronSessionKey()` depend on exact format.

4. **`agents/` ↔ `auto-reply/` is bidirectional by design** — Not a circular dependency bug. `agents/` provides runtime, `auto-reply/` orchestrates it.

5. **`agents/pi-embedded-subscribe.ts` processes SSE stream chunks** — It's a streaming state machine. Adding/removing events here can break tool call parsing, block chunking, or reasoning block extraction.

### Modules With Surprising Coupling

- **`auto-reply/thinking.ts`** exports `VerboseLevel` used by `sessions/level-overrides.ts` — changing enum values breaks session persistence.
- **`channels/dock.ts`** returns lightweight metadata to avoid importing heavy channel code. Must be updated when channel capabilities change.
- **`infra/outbound/deliver.ts`** is used by both cron delivery AND message tool sends — test both.
- **`config/sessions/store.ts`** uses file locking — concurrent writes can deadlock if lock isn't released.

### Race Conditions to Watch

- **Cron service uses `locked()`** (in `cron/service/locked.ts`) to serialize operations. Removing this causes race conditions.
- **Session file writes**: `agents/session-write-lock.ts` provides file-based locking. Concurrent JSONL appends without locking corrupt files.
- **Gateway config reload**: `gateway/config-reload.ts` uses chokidar debounce. Rapid config changes can trigger multiple reloads.
- **Telegram media groups**: `bot-updates.ts` aggregates photos with a timeout window. Changing this can split or merge groups incorrectly.

### Other Landmines

- **JSON5 vs JSON**: Config files are JSON5 (comments, trailing commas). Session files, cron store, auth profiles are strict JSON. Don't mix parsers.
- **Telegram HTML formatting**: `telegram/format.ts` converts Markdown→Telegram HTML. Telegram's HTML subset is limited — broken HTML silently fails.
- **Discord 2000 char limit**: `discord/chunk.ts` enforces limits with fence-aware splitting. Don't bypass the chunker.
- **Signal styled text**: Uses byte-position ranges, not character positions. Multi-byte chars shift ranges.
- **WhatsApp target normalization**: Converts between E.164, JID (`@s.whatsapp.net`), and display formats. Getting this wrong means messages go nowhere silently.
