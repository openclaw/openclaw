---
summary: "The remaining doctor checks and repairs, from Nix mode to plugins, sandbox, and channels"
title: "Other checks and repairs"
read_when:
  - You want to know whether doctor covers a specific check or repair
  - Doctor reported a check you do not recognise
---

These are the remaining checks and repairs `openclaw doctor` performs, beyond the
postures and maintenance modes documented on the other pages.

<a id="notes" />

## Modes and prompting

- In Nix mode (`OPENCLAW_NIX_MODE=1`), read-only doctor checks still work, but `doctor --fix`, `doctor --repair`, `doctor --yes`, and `doctor --generate-gateway-token` are disabled because `openclaw.json` is immutable. Edit the Nix source for this install instead; for nix-openclaw, use the agent-first [Quick Start](https://github.com/openclaw/nix-openclaw#quick-start).
- Interactive prompts (keychain/OAuth fixes, etc.) only run when stdin is a TTY and `--non-interactive` is **not** set. Headless runs (cron, Telegram, no terminal) skip prompts.
- Standalone non-interactive mode skips prompts, not full provider-catalog or runtime-tool validation. Update-time optional checks can be [deferred with warnings](/cli/doctor/running#postures). Built checkout runs reuse available compiled plugin entries for these checks; intentional source overrides still execute source. See [Development debugging](</help/debugging#dev-profile-%2B-dev-gateway-(--dev)>).
- `--lint` is stricter than `--non-interactive`: always read-only, never prompts, never applies safe migrations. Use `doctor --fix` or `doctor --repair` when you want doctor to make changes.
- Doctor does not execute `exec` SecretRefs while checking secrets by default. Use `--allow-exec` (with or without `--lint`) only when you intentionally want doctor to run those configured secret resolvers.

## Choosing which findings to address

The final Doctor summary separates current problems from optional improvements.
The category describes what needs attention; the diagnostic severity remains
available to lint and automation.

| Finding                                                    | Priority and next step                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway mode or authentication is incomplete               | **Fix now.** Set the mode and credentials described in [Gateway configuration](/gateway/configuration), then rerun Doctor.                                                                                                                                      |
| A workspace alias points to a different folder             | **Fix now.** Restore the original link, or run `openclaw doctor --fix` and confirm only if the same workspace moved. Do not transfer records between unrelated workspaces.                                                                                      |
| Device auth or an existing pairing record is inconsistent  | **Fix now.** Inspect `openclaw devices list`, reconnect the device to request its intended access, and approve the exact request only after reviewing it. See [Devices](/cli/devices).                                                                          |
| A new device or access upgrade is awaiting approval        | **Recommended improvement.** Approve it if you want to grant the requested access; reject an unrecognized request. A pending request alone does not mean existing Gateway access is broken.                                                                     |
| A managed project clone is shallow or partial              | **Recommended improvement.** A full clone makes managed worktrees more reliable offline. Follow the printed repair commands, which preserve the clone's files; stop if any command fails. A missing or unreadable registered clone instead needs attention now. |
| Bootstrap files exceed the context budget                  | **Recommended improvement.** Shorten them to include more of their instructions in each turn, or adjust the supported agent budgets. See [Agent workspace](/concepts/agent-workspace). The Gateway can keep running with the configured truncation.             |
| Old plugin installation generations remain                 | **Recommended improvement.** Run `openclaw doctor --fix` to retire unused generations for safe pruning after restart. The current plugin installation remains authoritative.                                                                                    |
| WhatsApp pressure and local terminal clients were observed | **Recommended improvement.** Export [Gateway diagnostics](/gateway/diagnostics) before choosing an action. This observation does not prove those clients caused the pressure.                                                                                   |
| A Gmail hook model cannot be resolved                      | **Fix now.** Run `openclaw models list`, choose a configured provider/model for `hooks.gmail.model`, or remove the override to use the agent default. Check [Gmail automation](/automation/cron-jobs/gmail).                                                    |

Successful repair removes the resolved finding from the final summary. A repair
that was skipped or failed keeps its next step visible. Recommended improvements
do not require stopping a healthy Gateway simply to clear the summary.

## Config writes and backups

Update-history inspection and reconciliation are best-effort maintenance. A failure
prints a warning and allows independent Doctor repairs and plugin registry mutations
to continue. Writable passes also try to save the warning on the latest existing
SQLite update run, without changing its outcome or activity timestamps or creating
a new run. Read-only passes do not write history. Database integrity, migration,
and unsettled process cleanup checks still protect mutations.

Snapshot workers use the runtime executing the CLI. Native workers inherit an
unchanged working directory, avoiding a redundant directory change that can fail
after `sudo -u` switches users. A spawn refusal names the runtime and working
directory; check executable permissions and directory access for the service user.
Disk-space or `XDG_CACHE_HOME` guidance applies to snapshot storage failures, not
runtime launch permissions.

After its checks finish, `doctor --fix` settles its own inspection workers while retaining maintenance ownership, then checks whether abandoned updater runtimes can be removed. Independent OpenClaw processes, Worker threads, and shared-broker work still prevent removal. Doctor reports the holder PIDs and asks you to let their work finish before rerunning `openclaw doctor --fix`.

- On npm global installs, Doctor reports retained `.openclaw.package-backup-*.databases` directories (and `.openclaw-package-backup-*.databases`, the name a failed cleanup retires them under) beside the installed package, with their total regular-file size in bytes and human-readable units and a quoted removal command for each directory. The scan is bounded; incomplete sizes are lower bounds. If inspection is incomplete before any snapshot is found, Doctor warns and asks you to list the npm global root manually, including hidden entries. A missing global root produces no warning. This is warning-only, including with `--fix`: confirm no update is in progress and no recovery needs the snapshots before removing them manually. Updater-driven Doctor passes defer this check so they do not report the active update's snapshots; run standalone Doctor after the update settles.
- Any config write (including a `--fix` repair) rotates a backup to `~/.openclaw/openclaw.json.bak` (with a numbered `.bak.1`..`.bak.4` ring). `--fix` also drops unknown config keys reported by schema validation, listing each removal; it skips this while an update is in progress so partially written upgrade state is not stripped before its migration finishes.
- If `openclaw.json` cannot be parsed and no last-known-good config can be recovered, `doctor --fix` leaves the file unchanged and exits with an error instead of writing a partial replacement. The error points to `openclaw config validate` for the exact parse position and explains how to edit or regenerate the config.

## Gateway and service repairs

- Set `OPENCLAW_SERVICE_REPAIR_POLICY=external` when another supervisor owns the gateway lifecycle. Have that owner stop the Gateway, run Doctor as the state-owning account, then restart through the owner. Doctor skips native maintenance inspection and service mutations, including install/start/restart/bootstrap and legacy service cleanup; it keeps Gateway/state coordinators and agent-database lease checks, reports service health, and applies non-service repairs. See [Existing system LaunchDaemons](/gateway#existing-system-launchdaemons).
- Doctor and `gateway status --deep` distinguish an unavailable launchd domain, a missing systemd user bus, and native check access denial. See [Gateway and service recovery](/cli/doctor/recovery) for runtime-environment, `dbus-user-session`, and external-supervisor guidance.
- Doctor reports the managed Gateway's applied heap limit and the adaptive derivation used for the current host or container memory limit. Use `openclaw gateway status` for the same report outside a repair pass.
- Doctor and `openclaw gateway status` skip systemd content repair advice when the manager reports a masked or otherwise unloaded unit. Loaded-unit checks, readable-file fallback after a failed manager query, and unrelated backup or credential diagnostics remain active.
- On Linux, doctor ignores inactive extra gateway-like systemd units and does not rewrite command/entrypoint metadata while a systemd gateway service is active; explicit repair stops an eligible service before reconciling installation drift. Use `openclaw gateway install --force` to rewrite the managed base unit. If a systemd drop-in overrides `ExecStart=` or `WorkingDirectory=`, inspect it with `systemctl --user cat <unit>.service` and update or remove that drop-in yourself; reinstalling the base does not replace it. `Environment=` drop-ins remain supported.
- `doctor --fix --non-interactive` preserves the installed launcher and environment except for [eligible installation drift in a previously running service](/cli/doctor/recovery#gateway-service-recovery), including during update repair. Separately, Linux policy refresh backs up outdated OpenClaw unit settings, confirms `daemon-reload`, and verifies the effective shutdown timeout before maintenance. Operator drop-ins remain unchanged. Short or unknown resident shutdown budgets use bounded lifecycle drain; reported write custody refuses the deadline stop, while interrupted turns produce a warning. Stopped services keep their launcher and stop state; their Linux policy can refresh without activation. Run `openclaw gateway install` for a missing service, or `openclaw gateway install --force` from the intended installation to replace its launcher and managed environment.

## Session state and cron

- State integrity checks detect orphan transcript files in the sessions directory. Archiving them as `.deleted.<timestamp>` requires interactive confirmation; `--fix`, `--yes`, and headless runs leave them in place.
- Doctor scans historical `~/.openclaw/cron/jobs.json` stores and previously configured legacy store locations for old cron job shapes, imports jobs and quarantine records into SQLite, and archives the migrated JSON files.
- Doctor reports cron jobs with an explicit `payload.model` override, including provider-namespace counts and mismatches against `agents.defaults.model`, so scheduled jobs that do not inherit the default model are visible during auth or billing investigations.
- Doctor reports cron jobs still marked in-flight (`state.runningAtMs`), which can make `openclaw cron list` show them as `running`. This check is read-only: if no Gateway is currently executing a marked job, the next cron service startup records the interrupted run and clears the marker.

## Tool and channel policy

- Doctor inspects active tool schemas once per run, sharing plugin registration across the fleet while checking each agent's tool factories, policy, and selected model. Model preparation also shares provider registrations and config snapshots when agents resolve to the same plugin sources within one captured configuration generation; distinct plugin selections and explicit workspace registry owners remain separate. Failed plugin registrations and cleanup produce findings without hiding healthy agents' results. If a model needs live provider discovery, Doctor reports that its model-specific schema inspection was deferred; normal authenticated agent use performs that discovery. Standalone lint retains its read-only catalog checks. Update-time inspection can be deferred with a recorded warning.
- Doctor reports legacy image-inspection policy entries named `image`. `openclaw doctor --fix` rewrites supported config allow/deny surfaces and persisted automation `toolsAllow` entries to `view_image`; old-only wildcard patterns such as `image*` are preserved and gain an explicit `view_image`, while patterns that already cover both names remain unchanged. Runtime exposes only the current name.
- On Linux, doctor warns when the user's crontab still runs the unmaintained legacy `~/.openclaw/bin/ensure-whatsapp.sh`, which can misreport `Gateway inactive` when cron lacks the systemd user-bus environment.
- When WhatsApp is enabled, doctor can report Gateway pressure and detected local TUI clients. These observations do not identify the cause or connect a client to that Gateway. Inspect [Gateway diagnostics](/gateway/diagnostics) before deciding whether to close clients; Doctor does not stop them.
- When HTTP(S) proxy environment variables are present but `tools.web.fetch.useTrustedEnvProxy` is disabled, doctor explains that `web_fetch` still uses direct routing, runs a short direct TLS connectivity check, and names the explicit opt-in. It never enables proxy trust automatically.

## Models and auth

- Doctor rewrites legacy `codex/*` and `openai-codex/*` model refs to current `openai/*` refs across primary models, fallbacks, model allowlists, image/video generation models, heartbeat/subagent/compaction overrides, hooks, channel model overrides, cron payloads, and stale session/transcript route pins. `--fix` also merges legacy `models.providers.codex` and `models.providers.openai-codex` config when safe, migrates legacy `openai-codex:*` auth profiles and `auth.order.openai-codex` entries to `openai:*`, moves Codex intent onto provider/model-scoped `agentRuntime.id: "codex"` entries, removes stale whole-agent/session runtime pins, and keeps repaired OpenAI agent refs on Codex auth routing instead of direct OpenAI API-key auth.
- Doctor also repairs retired model names in preferred media selections and converts CLI-encoded model references across fallback lists, model maps, media slots, and session provider/model pairs. Migrated agent selections keep per-model runtime choices; explicit current runtimes and session runtime overrides win. Current entries win collisions while missing nested settings are retained. These reference repairs preserve account pins, custom namespaced model IDs, and session bindings.
- Doctor reports an info finding when an active model reference names a known provider but is missing from that provider's local catalog. Providers that contribute no catalog rows offline (for example OpenRouter, whose catalog is discovered at runtime) are skipped, because an unlisted id there is not evidence of a typo.
- `doctor --fix` moves the old Claude-only conversation ID into the provider-keyed session binding before removing the old field. Existing bindings and their resume metadata take precedence. Empty or ambiguous bindings stay saved with a reconciliation warning while safe sessions migrate. When Doctor clears stale Claude routing state outside the configured route, it also clears the old field so migration cannot restore that conversation. Run this repair after upgrading before resuming sessions that only have the old field; runtime lookup and normal saves use provider-keyed bindings.
- `doctor --fix` migrates retired auth provider and profile identifiers in existing shared and agent SQLite stores, as well as legacy JSON imports. It preserves credentials and account metadata, uses unused profile IDs for collisions, and updates config references and rotation state together. Existing migration receipts retain verified account mappings across an interrupted store pass or failed config write; a changed account is not adopted on retry. Explicit empty config orders stay empty. Unreadable stores and unresolved credential realms remain unchanged with diagnostics; independent safe stores can still migrate.
- Doctor reports nonempty `auth.order.<provider>` lists whose referenced profiles are all gone while compatible stored credentials exist. `doctor --fix` deletes only those stale overrides, restoring automatic per-agent credential selection; explicit empty orders, partially live lists, and orders without a compatible stored credential stay unchanged. If an active SQLite auth store is unreadable or malformed, doctor explains why it skipped this repair. Restart a running Gateway before rechecking auth status if its config reload mode does not apply the write automatically.
- When `doctor --fix` removes a stale agent-local OAuth copy so the agent inherits the shared account, it preserves that account's position in the agent's saved auth order. Local cooldown and success state for the removed copy are cleared; the shared credentials and other local accounts remain unchanged. This also applies when Doctor runs during an update.

## Plugins and skills

- `doctor --fix` reclaims abandoned legacy plugin captures and retained updater runtimes during maintenance. Unfamiliar launcher syntax alone does not block cleanup when readable working-directory and package evidence establish that a process is unrelated. Absolute entrypoint paths still require readable foreign package identity. OpenClaw identities, entrypoint and module references, capture/runtime paths, and native capture custody preserve live artifacts. Unreadable same-user arguments or unresolved working-directory, script, package, or service-marker evidence leave cleanup skipped with a warning; failed evidence inspection is never treated as proof that a process is unrelated.
- First-write native session catalog privacy preferences do not enable plugins or expand `plugins.allow`. Doctor warns when an enabled Codex entry contains only the catalog opt-out and matches the possible accidental enablement from OpenClaw 2026.9.3/9.4. This signature cannot distinguish the old automatic write from an intentional choice, so `--fix` preserves it. If you did not enable Codex, set `plugins.entries.codex.enabled` to `false` and remove `codex` from `plugins.allow` if present, preserving the other entries.
- Doctor preserves legacy shared plugin-runtime caches that another installation or profile may still use and removes only genuinely dangling plugin-runtime symlinks. It relinks the host `openclaw` package for managed npm plugins that declare it as a peer dependency. It also repairs missing downloadable plugins referenced by config (`plugins.entries`, configured channels, configured provider/search settings, configured agent runtimes). During package updates, doctor skips package-manager plugin repair until the package swap completes; rerun `openclaw doctor --fix` afterward if a configured plugin still needs recovery. If a download fails, doctor reports the install error and preserves the configured plugin entry for the next repair attempt.
- `doctor --fix` also updates drifted active official npm plugins from the OpenClaw catalog to the installed OpenClaw release, using the same plugin updater as `openclaw update`. Recorded non-default tags and pins newer than the release's plugin cohort keep their selected targets. It reports each outcome and rechecks restart readiness. A plugin that cannot be fetched remains a warning with the failure reason; other plugins can still be repaired and Doctor can finish. This repair leaves third-party plugins unchanged. The normal [Gateway maintenance and restart policy](/cli/doctor/running#postures) applies; follow the printed restart command when Doctor does not restart the Gateway for you.
- Doctor repairs stale plugin config by removing missing plugin ids from `plugins.allow`/`plugins.deny`/`plugins.entries`, plus matching dangling channel config, heartbeat targets, and channel model overrides, when plugin discovery is healthy.
- Doctor quarantines invalid plugin config by disabling the affected `plugins.entries.<id>` entry and removing its invalid `config` payload. Gateway startup already skips only that bad plugin so other plugins and channels keep running.
- Doctor removes the retired `plugins.entries.codex.config.codexDynamicToolsProfile`; the Codex app-server always keeps Codex-native workspace tools native.
- Doctor auto-migrates legacy flat Talk config (`talk.voiceId`, `talk.modelId`, and friends) into `talk.provider` + `talk.providers.<provider>`. Repeat `doctor --fix` runs no longer report/apply Talk normalization when the only difference is object key order.
- Doctor includes a memory-search readiness check and can recommend `openclaw configure --section model` when embedding credentials are missing.
- Doctor warns when no command owner is configured. The command owner is the human operator account allowed to run owner-only commands and approve dangerous actions. DM pairing only lets someone talk to the bot; if you approved a sender before first-owner bootstrap existed, set `commands.ownerAllowFrom` explicitly.
- Doctor reports an info note when Codex-mode agents are configured and personal Codex CLI assets exist in the operator's Codex home. Local Codex app-server launches use isolated per-agent homes; install the Codex plugin first if needed, then use `openclaw migrate plan codex` to inventory assets that should be promoted deliberately.
- Doctor warns when skills allowed for the default agent are unavailable in the current runtime environment (missing bins, env vars, config, or OS requirements). `doctor --fix` can disable those unavailable skills with `skills.entries.<skill>.enabled=false` and lists the changes without asking you to repeat the repair. Updater-driven repair leaves optional skill enablement unchanged. Install/configure the missing requirement instead if you want to keep the skill active.
- If an older Doctor run disabled a working `sag` skill, re-enable it with `openclaw config set skills.entries.sag.enabled true`.

## Sandbox

- If sandbox mode is enabled but Docker is unavailable, doctor reports a high-signal warning with remediation (`install Docker` or `openclaw config set agents.defaults.sandbox.mode off`).
- Doctor identifies per-agent `agents.entries.<id>.sandbox` Docker, browser, and prune overrides ignored under shared scope. It also warns when an agent's explicit primary model omits fallbacks and therefore disables the defaults' fallback chain; both diagnostics use current agent paths after legacy roster normalization.
- If retired sandbox registry files or shard directories are present (`~/.openclaw/sandbox/containers.json`, `~/.openclaw/sandbox/browsers.json`, `~/.openclaw/sandbox/containers/`, or `~/.openclaw/sandbox/browsers/`), Doctor reports them and `--fix` refuses without changing their contents. Upgrade through `2026.9.7` and run `openclaw doctor --fix` on the original host first; see [legacy state migration](/cli/doctor/state-migrations).

## Secrets and channel credentials

- If `gateway.auth.token`/`gateway.auth.password` are SecretRef-managed and unavailable in the current command path, doctor reports a read-only warning and does not write plaintext fallback credentials. For exec-backed SecretRefs, doctor skips execution unless `--allow-exec` is present.
- If channel SecretRef inspection fails in a fix path, doctor continues and reports a warning instead of exiting early.
- After state-directory migrations, doctor warns when enabled default Telegram or Discord accounts depend on env fallback and `TELEGRAM_BOT_TOKEN` or `DISCORD_BOT_TOKEN` is unavailable to the doctor process.
- Telegram `allowFrom` username auto-resolution (`doctor --fix`) requires a resolvable Telegram token in the current command path. If token inspection is unavailable, doctor reports a warning and skips auto-resolution for that pass.
