---
summary: "Where every OpenClaw setting lives on disk, who validates it, and how it is recovered when a write goes wrong"
read_when:
  - Investigating why a settings change broke gateway startup or hot reload
  - Mapping which file or schema owns a given config surface
  - Looking up the backup, recovery, and doctor behavior for openclaw.json
  - Wiring a third-party plugin into the config schema and recovery flow
title: "Configuration internals"
sidebarTitle: "Internals"
---

This page maps the storage and lifecycle of OpenClaw configuration: where every
surface lives on disk, which schema validates it, when it is loaded, how hot
reload swaps it, and what happens when a write fails validation. Use the
[Configuration overview](/gateway/configuration) for task-oriented guidance and
the [Configuration reference](/gateway/configuration-reference) for the full
field map. This page is the one to open when something already went wrong.

## Files on disk

OpenClaw owns a small set of files under `~/.openclaw/` (override the root
with `OPENCLAW_STATE_DIR`). All paths shown are defaults; the canonical config
path can be overridden with `OPENCLAW_CONFIG_PATH`.

| Path | Purpose | Writer |
|---|---|---|
| `~/.openclaw/openclaw.json` | Canonical configuration. JSON5 with comments and trailing commas. | `src/config/io.ts` via `src/config/mutate.ts` |
| `~/.openclaw/openclaw.json.bak` | Most recent successful copy. Used by the last known good recovery path. | `src/config/backup-rotation.ts` |
| `~/.openclaw/openclaw.json.bak.1` to `.bak.4` | Older backups in a 5 slot ring. | `src/config/backup-rotation.ts` |
| `~/.openclaw/openclaw.json.pre-update` | One time snapshot captured before a major update. Write once, never rotated. | `src/config/backup-rotation.ts` |
| `~/.openclaw/.config-health.json` | Last load result, fingerprint, degraded flag, recovery hints. | `src/config/io.ts` |
| `~/.openclaw/.oauth` | OAuth tokens for connected services. | `src/config/paths.ts` |
| `~/.openclaw/plugin-installs.json` | Installed plugin records. | `src/plugins/installed-plugin-index-records.js` |
| `~/.openclaw/<agent-id>/` | Per agent workspace, transcripts, session state. | `src/agents/agent-scope-config.ts` |
| `./.env` or `~/.openclaw/.env` | Dotenv overrides loaded into `process.env`. | `src/infra/dotenv.js` |

The active config file must be a regular file. Symlinks at the config path are
not supported because the atomic write replaces the path target instead of
following the link. If you keep the file outside the default state directory,
point `OPENCLAW_CONFIG_PATH` at the real file, not at a symlink to it.

## Settings categories

Every category below is a top level key under `openclaw.json` unless noted.
The schema column points at the Zod module that owns validation; the
documentation column points at the user facing page.

| Key | Owns | Schema | Documentation |
|---|---|---|---|
| `agents` | Agent identities, defaults, per agent overrides | `src/config/zod-schema.agents.ts` | [config-agents](/gateway/config-agents) |
| `channels` | Per channel auth, allowlists, group policy, presence | `src/config/zod-schema.providers.ts` | [config-channels](/gateway/config-channels) |
| `models` and `agents.defaults.models` | Model catalog and allowlist | `src/config/zod-schema.providers-core.ts` | [Models](/concepts/models) |
| `tools` and `plugins.entries.<id>.config` | Tool and skill plugin configuration | Plugin contributed via `src/plugin-sdk/plugin-config-runtime.ts` | [config-tools](/gateway/config-tools) |
| `plugins` | Plugin allow and deny lists, per plugin enable and hooks | `src/config/zod-schema.ts` | [Plugin reference](/plugins/reference) |
| `gateway` | Port, auth mode, control UI, reload mode, Tailscale, remote | `src/config/zod-schema.ts` | [Configuration overview](/gateway/configuration) |
| `hooks` | Internal hooks, Gmail hooks, channel mappings | `src/config/zod-schema.hooks.ts` | [Hooks](/automation/hooks) |
| `session` | Commands, messages, send policy | `src/config/zod-schema.session.ts` | [Configuration reference](/gateway/configuration-reference#session) |
| `approvals` | Tool approval policy | `src/config/zod-schema.approvals.ts` | [Configuration reference](/gateway/configuration-reference#approvals) |
| `memory` | Memory backend, QMD configuration | `src/config/zod-schema.ts` (`MemoryQmdSchema`) | [memory-config](/reference/memory-config) |
| `logging` and `diagnostics` | Levels, OTEL, cache trace | `src/config/zod-schema.ts` | [Configuration reference](/gateway/configuration-reference#logging) |
| `proxy` | Outbound proxy | `src/config/zod-schema.proxy.ts` | [Configuration reference](/gateway/configuration-reference#proxy) |
| `env` | Inline environment variables and shell env policy | `src/config/zod-schema.ts` | [Configuration reference](/gateway/configuration-reference#env) |

Per agent and per project state lives outside `openclaw.json`:

- Per agent: `~/.openclaw/<agent-id>/`, owned by `src/agents/agent-scope-config.ts`.
- Per project: managed by the `@earendil-works/pi-coding-agent` settings manager via `src/agents/pi-project-settings.ts`. Project settings travel with the project, not with `openclaw.json`.

## Validation surfaces

The master schema is `OpenClawSchema` exported from `src/config/zod-schema.ts`.
It composes the sub schemas listed in the table above. The top level entry
point for validating an in memory config object is
`validateConfigObjectWithPlugins` in `src/config/validation.ts`.

Validation runs in three places:

1. After read, before any in process consumer sees the parsed object.
2. After every transform, before writing the new copy to disk.
3. At hot reload time, on the candidate config, before swapping the runtime snapshot.

Validation is strict. Unknown keys, malformed types, and out of range values
are rejected. The only root level exception is `$schema` (string), which lets
editors attach JSON Schema metadata. See the [Strict validation](/gateway/configuration#strict-validation)
section of the overview for the user facing contract.

Generated metadata for bundled channel plugins lives at
`src/config/bundled-channel-config-metadata.generated.ts`. It is produced by
`scripts/generate-bundled-channel-config-metadata.ts` and validated at build
time. Hand edits to the generated file are overwritten on next generation.

## Read and write lifecycle

A normal write from any callsite goes through
`transformConfigFileWithRetry` in `src/config/mutate.ts`. The steps are:

1. Acquire a file lock with a 30 second stale timeout. Concurrent writers are queued.
2. Read the current file plus its fingerprint via `resolveConfigSnapshotHash`.
3. Call the user supplied transform on the parsed object.
4. Validate the transformed object with `validateConfigObjectWithPlugins`. If validation fails, the write aborts and the lock is released without touching disk.
5. Run backup rotation through `maintainConfigBackups`: shift `.bak.1..4`, copy the current file into `.bak`, harden permissions to `0o600`, prune orphan `.bak.*` files.
6. Atomic write through `replaceFileAtomic`: write to a temp sibling, then rename over the target.
7. Update `.config-health.json` with the new fingerprint and recovery hints.
8. Notify in process listeners via `notifyRuntimeConfigWriteListeners`.

The lock plus the base hash check protect against lost updates when two writers
race. A write whose base hash no longer matches the on disk file is rejected
with `ConfigMutationConflictError`; the caller retries with fresh state.

Direct file writes that bypass `transformConfigFileWithRetry` are not
supported. Plugin authors should write through the SDK helpers, not through
`fs.writeFile`.

## Hot reload

Hot reload is configured via `gateway.reload`:

| Mode | Behavior |
|---|---|
| `off` | The gateway ignores config file changes. Requires manual restart. |
| `restart` | The gateway process bounces on any change. Cleanest but interrupts active conversations. |
| `hot` | The gateway mutates channel and plugin state in place. Fastest but the most fragile mode. |
| `hybrid` (default) | Hot mutate for cheap surfaces, restart for surfaces that cannot be safely mutated live. |

Hot reload runs through `src/gateway/config-reload.ts` and reads its settings
from `src/gateway/config-reload-settings.ts`. The debounce window
(`gateway.reload.debounceMs`) coalesces editor save bursts and rapid CLI runs.

A reload that fails validation does not bring the runtime down: the gateway
keeps serving on the last accepted config and logs the validation error. The
file on disk is left as is; the user must fix it before the next reload will
succeed.

## Backups and recovery

OpenClaw maintains a 5 slot backup ring plus a one time `.pre-update`
snapshot. The mechanics live in `src/config/backup-rotation.ts`.

- `rotateConfigBackups` shifts every backup down one slot before each successful write.
- `hardenBackupPermissions` chmods every backup to `0o600` (POSIX only; the call is a no op on Windows).
- `cleanOrphanBackups` deletes `.bak.<n>` files outside the managed slots so a stray copy does not confuse recovery.
- `createPreUpdateConfigSnapshot` is called once per major update with the `wx` open flag, so an existing snapshot is never overwritten.

Recovery from a bad config lives in `src/config/io.observe-recovery.ts`. Two
helpers matter:

- `recoverConfigFromLastKnownGood`: copies `.bak` over `openclaw.json` and re-validates the result. Used by `openclaw doctor --fix`.
- `promoteConfigSnapshotToLastKnownGood`: marks the current snapshot as the new `.bak`. Skipped when the candidate contains redacted secret placeholders such as `***`, so a secret scrub never poisons the recovery anchor.

The decision of whether to attempt recovery is made by `src/config/recovery-policy.ts`:

- `shouldAttemptLastKnownGoodRecovery` answers yes only when the failure is non plugin local. Plugin local issues (a missing plugin entry, a renamed plugin key) are recoverable by re enabling the plugin or running its install repair, not by rolling back the whole file.
- `isPluginLocalInvalidConfigSnapshot` is the predicate that lets the gateway keep running on a plugin scoped problem without escalating to a full file swap.

A startup failure today is reported, but the rollback is not automatic. Run
`openclaw doctor --fix` (or `--yes`) to apply the rollback once you have
inspected the error. This is the behavior contract documented in the
[Configuration overview](/gateway/configuration#strict-validation).

## Doctor coverage

`openclaw doctor` and `openclaw doctor --fix` live in `src/commands/doctor.ts`
and `src/commands/doctor/`. For settings, doctor today handles:

- Detecting and reporting validation failures with the schema diagnostic.
- Applying legacy migration rules from `src/commands/doctor/shared/legacy-config-rules.js` (re exported through `src/config/legacy.rules.ts`).
- Repairing plugin local invalid snapshots without touching the whole file (`src/commands/doctor/repair-sequencing.ts`).
- Restoring `.bak` on operator confirmation when the failure is non plugin local.

Doctor does not auto repair:

- Unknown top level keys. They are reported, not stripped.
- Malformed provider or channel credentials. The auth subsystem owns those flows.
- Circularly referenced includes. The include resolver bails out and reports the cycle.

## Environment variables

The full list lives in `.env.example` at the repo root. The most common
categories are:

- **State and paths**: `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_HOME`, `OPENCLAW_AUTH_PROFILE_SECRET_DIR`, `OPENCLAW_INCLUDE_ROOTS`.
- **Gateway auth**: `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_PASSWORD`.
- **Shell env loading**: `OPENCLAW_LOAD_SHELL_ENV`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS`.
- **Provider API keys**: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, plus numbered and comma separated variants for rotation pools.
- **Channel credentials**: `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `MATTERMOST_BOT_TOKEN`, and similar per channel tokens.
- **Tool keys**: `BRAVE_API_KEY`, `PERPLEXITY_API_KEY`, `FIRECRAWL_API_KEY`, `ELEVENLABS_API_KEY`, `INWORLD_API_KEY`, `DEEPGRAM_API_KEY`.

Precedence at load time is: `process.env`, then `./.env`, then
`~/.openclaw/.env`, then the `env.vars` block in `openclaw.json`. Earlier wins
over later. The list of declared vars and their parsers lives in
`src/config/config-env-vars.ts`.

## Plugin and channel config

Plugins declare a config schema in their manifest (`configSchema`). The
runtime merges the user value from
`config.plugins.entries.<pluginId>.config` over the plugin defaults and
validates the result before handing it to the plugin. The integration code is
in `src/plugin-sdk/plugin-config-runtime.ts`.

A plugin entry has three subkeys:

- `enabled` (boolean, optional): off switch without removing the entry.
- `config` (object): plugin specific settings validated by the plugin schema.
- `hooks` (object, optional): event handlers mapped through `src/config/zod-schema.hooks.ts`.

Per channel config lives under `config.channels.<type>`. Each channel ships
its own zod sub schema, and the bundled set is generated into
`src/config/bundled-channel-config-metadata.generated.ts`. Third party
channels register at runtime through the plugin manifest registry and are
merged into the live schema when the gateway loads.

## When things go wrong

A decision tree for the most common failure modes:

1. **Gateway refuses to start.** Run `openclaw doctor`. If the failure is plugin local, disable the plugin in `config.plugins.entries.<id>.enabled` or run the plugin install repair. If non plugin local, run `openclaw doctor --fix` to restore the last known good copy from `.bak`. Inspect the failed file under `~/.openclaw/openclaw.json` after the restore to learn what change broke it.

2. **Hot reload silently does nothing.** Check the gateway logs. A reload that fails validation logs the error and keeps the previous runtime snapshot. Fix the file and save again to retrigger the watcher.

3. **An AI agent wrote an unknown key.** The validation diagnostic lists the offending path. Use `openclaw config schema` or the `config.schema.lookup` RPC to confirm the supported keys. Either rename to the correct key or remove the entry. The strict policy is documented and is not user disableable.

4. **A backup is missing or stale.** Backups rotate on every successful write. If `.bak` is older than expected, recent writes failed validation and never advanced the ring. Look at `.config-health.json` for the last successful fingerprint.

5. **A secret leaked into a backup.** Backups are chmod 0o600 by default. If the on disk permissions look wrong, run `openclaw doctor --fix`, which calls `hardenBackupPermissions`. Snapshots that contain redacted placeholders (`***`) are never promoted to last known good, so a scrub never poisons recovery.

## Known limitations

These are documented gaps that operators should know about until they are
closed. They are tracked in repo issues; check the changelog for status.

- Auto rollback to last known good is not applied on startup or hot reload today. Recovery is manual through `openclaw doctor --fix`.
- `replaceFileAtomic` relies on POSIX rename atomicity. Network mounts (NFS, some Docker volume drivers) do not guarantee it; a crash mid rename can leave a partial file. Keep config on a local filesystem.
- Env var substitution resolves after schema validation. A reference to a missing variable like `${MISSING_VAR}` survives validation as a literal string and surfaces only at use time.
- The runtime snapshot setter does not re validate the candidate. Callers must ensure the object already passed `validateConfigObjectWithPlugins`.

## Related pages

- [Configuration overview](/gateway/configuration)
- [Configuration reference](/gateway/configuration-reference)
- [Configuration examples](/gateway/configuration-examples)
- [config-agents](/gateway/config-agents)
- [config-channels](/gateway/config-channels)
- [config-tools](/gateway/config-tools)
- [Config CLI](/cli/config)
- [Doctor CLI](/cli/doctor)
