---
summary: "Disk layout, cron store, session, model auth, sandbox, and plugin install repairs (checks 3-7b)"
title: "State, session, and plugin repairs"
read_when:
  - Doctor reports a state migration, session lock, or plugin install problem
  - You are changing on-disk state layout or state integrity checks
---

Checks 3-7b cover legacy on-disk state migrations, session integrity, model
auth health, sandbox images, and plugin installs.

## Checks 3-7b

<AccordionGroup>
  <Accordion title="3. Legacy state migrations (disk layout)">
    Supported upgrade sources are state shapes written by releases shipped on or after July 1, 2026. The July Doctor importer could still leave `provider` and `lastProvider` aliases on session rows. Session reads refuse those rows with a migration-required error until `openclaw doctor --fix` runs; Doctor backs up the affected SQLite databases, then rewrites the aliases into the current `delivery` state and its query projections together. Rows that still need the retired `room` → `groupChannel` conversion are refused without changing the original store: preserve the state, install OpenClaw `2026.9.5`, run `openclaw doctor --fix`, then upgrade again. Rows with current fields remain supported even when obsolete metadata remains alongside them. July-era `sessions.json` and JSONL transcript imports remain supported.

    Doctor can migrate supported on-disk layouts into the current structure:

    - Session rows and transcripts: import legacy `sessions.json` and JSONL history from per-agent `sessions/` directories or explicitly configured stores into `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
    - Agent dir: from `~/.openclaw/agent/` to `~/.openclaw/agents/<agentId>/agent/`
    - WhatsApp auth state (Baileys): from legacy `~/.openclaw/credentials/*.json` (except `oauth.json`) to `~/.openclaw/credentials/whatsapp/<accountId>/...` (default account id: `default`)
    - Signed device identity: from `~/.openclaw/identity/device.json` into the `primary` `device_identities` row in `state/openclaw.sqlite`; Doctor also owns repair of invalid stored rows; Gateway and node-host startup refuse an unimported identity instead of creating a replacement, and leave the separate device-auth file untouched

    Imports of the pre-June `tasks/runs.sqlite`, `flows/registry.sqlite`, and `plugin-state/state.sqlite` databases are retired. Doctor leaves these files untouched. Older installations that need their records should [upgrade through `2026.9.5`](/install/updating#upgrading-very-old-versions) and run its Doctor migrations before installing `latest`; June-and-later releases already use the shared state database.

    The JSON plugin index at `plugins/installs.json` is retired. Doctor leaves it unchanged and directs operators to run `openclaw doctor --fix` on `2026.9.5` with a pre-update backup. Updates also check this original file before stopping the running Gateway. Current SQLite plugin indexes and install records remain supported.

    Retired Skill Workshop proposals belong to Doctor, including the repair pass during `openclaw update`. Doctor exports each pending or quarantined draft to `<agentDir>/workshop-skills/.archive/.retired-proposals/<proposal-id>/`, drops the retired proposal tables, and removes `<state-dir>/skill-workshop/proposals/`. Normal Gateway and local CLI startup leave those artifacts untouched. A failed export keeps the tables and files and reports a warning; rerun `openclaw doctor --fix` after fixing the cause.

    A rewritten or truncated legacy audit raw archive does not stop Doctor or update finalization. Doctor quarantines it beside itself, preserves the sanitized archive and existing SQLite records, and reports the quarantined path once. Later repairs continue. See [legacy audit recovery](/cli/update/repair-and-recovery#skipped-legacy-audit-recovery) for retained backups and recovery limits.

    Historical inline assistant directives in SQLite transcripts and archives are normalized by Doctor, including plain `openclaw doctor --non-interactive`. Gateway and ordinary CLI startup leave those historical bytes untouched. When replacing a binary without the updater, stop the Gateway and run Doctor against the same state/config before restarting if old history still contains reply, audio, TTS, or reaction markers. The official [container image entrypoint](/install/docker#upgrading-container-images) runs Doctor automatically before Gateway activation. This normalization keeps its existing completion cursor and stopped-writer checks; it does not enable repair-only maintenance, service changes, or exec-approval migration.

    Repair prepares retained archive media normalization from read-only database snapshots before stopping a managed Gateway. Unchanged archives require no archive write transaction. Doctor records verified content and file identities in existing migration metadata, so another run at the same version skips parsing and reading unchanged archive copies. Imports, restores, changed files, and new versions invalidate those facts; stored blob digests are still checked. Actual repairs retain stopped-writer authority and source revalidation.

    Automatic discovery no longer imports the pre-agent `~/.openclaw/sessions/` layout. An explicit session-store path remains supported, including a configured path at that location.

    Legacy session-file import and repair belong to Doctor. Gateway startup checks readiness without importing those files; runtime session access uses only SQLite. An unreadable legacy session index and its transcripts remain at their original paths, and repeated startups refuse readiness with the Doctor command for the active profile. Stop the Gateway, back up its state, repair the named source, and run `openclaw doctor --fix` before restarting it. The [targeted migration sequence](/cli/doctor#session-sqlite-migration) provides inspection and validation evidence. Current SQLite maintenance does not require legacy files to remain on disk.

    When an unavailable plugin still needs legacy session files, Doctor retains those originals after verifying the core import. Startup accepts the retained files only when their session owners have matching verified imports. An unused configured agent does not need an empty database for another agent's history. Changed, unassigned, or unimported source rows still require repair before startup.

    Deferred session import receipts bind the database inode and supported creation time, so a virtual filesystem device-number change after reboot does not invalidate a verified import. Retained source files keep their SHA-256 and size checks; normal SQLite edits and deletions remain authoritative. Doctor's import/recovery pass upgrades older device-and-inode receipts once in the existing receipt JSON. If the old physical identity no longer matches, Doctor verifies retained sources against stored history before rebinding. A changed or incomplete database keeps its recovery warning and cannot replay retained sessions.

    Doctor retains one prepared plugin selection through planning and post-session repair. A deferred external plugin stays deferred while admitted plugins complete their repairs; changing maintenance scopes does not add unplanned actions or block an update with an action-order mismatch. When no plugin migration is deferred and no verified legacy session source is retained, the post-session plugin repair runs its detectors once and skips the completion certification pass. Gateway startup reports pending repairs without executing them.

    Before archiving retained originals, Doctor rechecks pending plugin migrations against the current publication transaction. If those obligations changed during repair, the originals remain protected and Doctor reports the conflict for a later repair.

    A missing transcript remains a warning when the available history and session metadata were imported successfully, including while a plugin migration is pending. Later Doctor runs preserve current SQLite edits and deletions instead of replaying the retained index. The missing-history warning keeps that index protected after archival. If a previously missing transcript appears, Doctor preserves it and reports a source conflict for inspection before completing the deferred migration.

    If an agent schema upgrade is interrupted after the database commits, rerun `openclaw doctor --fix` with a compatible OpenClaw build. Doctor refreshes the registration of each successfully verified database, including retained registered databases inside the active state directory whose agents are no longer configured.

    An unfinished agent deletion keeps ownership of its database during an update. Doctor includes resumable pending stores in schema preflight and pre-migration backups, then prepares their schemas under the current deletion owner. Other per-agent content migrations defer those stores. Gateway recovery resumes the full session cleanup, including native bindings and related state, before removing or retaining files according to the original deletion request. This also supports older journals without a phase field. Completed retained deletions and unfinished Claw removals keep their existing restoration and removal owners.

    Doctor finishes database work started by its repair before releasing maintenance. A check that finds no repair leaves existing runtime handles open. If maintenance ownership is lost, Doctor stops its repairs and cleans up its own resources without closing independently admitted runtime work.

    `openclaw doctor --fix`, including the repair pass during `openclaw update`, removes surrounding whitespace from historical task run IDs and child session keys. It repairs related subagent task bindings in the same transaction while preserving task IDs, physical subagent run IDs, and delivery records. If distinct run IDs would become the same ID, Doctor leaves the transaction unchanged and reports the conflicting bindings. New task writes normalize these fields before persistence; Gateway reads use the existing indexes without scanning for whitespace repairs. When replacing a binary directly, run Doctor against the same state before starting the new Gateway; official container image activation includes this repair pass.

    On Windows, standalone `openclaw doctor --fix` consolidates internal database registrations that use both ordinary and extended-length (`\\?\` or `\\?\UNC\`) paths, keeping the newest recorded facts in the state-relative row. External database locations keep their existing spelling. Doctor skips this repair with a warning during an update, including the candidate Doctor pass, so the updater's captured rollback inventory stays unchanged. Rerun standalone Doctor after the update finishes to repair existing aliases.

    Doctor reports individual channel migration-plan failures while continuing plans for unrelated sources, including those from the same plugin. Plans sharing the failed source are deferred, and source cleanup waits for its last consumer to finish without reported failures or incomplete imports. Advisory readiness warnings allow the Gateway to start degraded. Startup logs the warnings once with the exact repair command; `openclaw status` and `openclaw doctor` show the running Gateway's warning report. Run `openclaw doctor --fix` against the same state/config, then restart the Gateway. Warning-bearing migrations remain incomplete until a later Doctor run. State that is unsafe to read still refuses startup.

    If an agent database belongs to a different agent, Doctor checks for a misplaced duplicate before upgrading either database. Only byte-identical database files, with absent or identical sidecars and archive dependencies, qualify. Doctor checkpoints and rechecks them under its maintenance lease, preserves the misplaced copy using the existing `.corrupt-<timestamp>` recovery filenames, and lets the affected agent start with a fresh database. The warning names the preserved path.

    Divergent or unverified copies remain in place. For a configured secondary agent with a verified ownership mismatch, the Gateway starts with that agent unavailable and continues serving healthy agents. `openclaw agents list`, status, and Doctor report the degraded agent; turns addressed to it return the recorded refusal reason. A refusal affecting the default or system agent, or the shared state database, still blocks startup.

    Doctor reports the embedded owner and the existing explicit quarantine command for an operator who has inspected the data and stopped OpenClaw. Independent state migrations still run; repairs requiring the refused database are skipped and reported as warnings. Admission is derived from the database files and held only in the running process. After repairing or explicitly quarantining the misplaced copy, restart the Gateway to evaluate admission again. There is no persisted refusal or separate clearance record.

    JSON delivery files under `delivery-queue/` and `session-delivery-queue/` were last written before July 1, 2026. Their import is retired. Doctor and startup leave these files untouched and stop with guidance to upgrade through `2026.9.7` and run its `openclaw doctor --fix` first. Back up the full state directory, including queue-owned media, before that intermediate upgrade. Current SQLite queues and their retry policies are unchanged.

    Doctor also prepares retired raw outbound rows already in SQLite, including interrupted preparation and media-staging checkpoints. It loads the configured plugin runtime only when preparation or send reconciliation needs it, preserves the existing modifier order and cancellation policy, and disposes that runtime before completing repair. Prepared checkpoints finish without rerunning modifiers. Missing plugins or media leave the existing custody and retry warnings for another `doctor --fix` pass. Normal Gateway startup reports legacy SQLite rows without converting them; it continues recovery and retries for the current prepared queue.

    If plugin cleanup reports retained resources, Doctor keeps its maintenance ownership and fails the repair. Resolve that process's cleanup failure before restarting the Gateway; another invocation cannot take over its lease while those resources may still write. Fully settled callback errors remain visible but do not retain maintenance ownership.

    Existing `.migrated` JSON files and `.media.migrated` directories remain recovery artifacts. They are not pending messages and are not automatically removed. Review preserved recipients, text, and attachments before sending a new message; do not rename archived files back into a queue to request replay.

    Doctor emits warnings when migrations leave legacy folders behind as backups. WhatsApp auth is intentionally only migrated via `openclaw doctor`. Talk provider/provider-map normalization compares by structural equality, so key-order-only diffs no longer trigger repeat no-op `doctor --fix` changes.

    When an explicit roster no longer contains `main`, only `openclaw doctor --fix` migrates durable `agent:main:*` SQLite rows, and only if the replacement owner is unambiguous: the sole roster member or the configured upgrade owner in `agents.defaults.sessionStore.agentId`. The explicit owner works for both per-agent and fixed session stores; fixed-store runtime ownership remains scoped to that physical store. Gateway startup, embedded TUI startup, CLI preflight, and first-agent onboarding only inspect retained claims and report a Doctor hint; they do not move or delete rows, restore legacy transcript generations, or write legacy-main migration receipts.

    `openclaw doctor --fix` first imports any legacy JSON session store, then keeps the winning primary-session claim and renames each losing claim to `agent:<owner>:legacy-main-conflict-<n>` in its original database. Quarantine changes only the key; the entry and full transcript remain available for inspection or archival.

    Doctor also repairs missing historical session titles from the first user request in a bounded transcript prefix. It preserves explicit names and session activity, skips running and incognito sessions, and does not restore cold history or call a model. After session-key normalization, it normalizes eligible legacy ACP metadata keys while preserving their stored lifecycle bindings. Missing, stale, or conflicting ACP claims remain available for inspection with a warning. Gateway startup and ordinary reads do not perform either repair.

    Doctor detects missing current-format workspace metadata on managed-worktree sessions and repairs it after session-key repairs have settled. Gateway startup does not scan for these legacy workspace repairs. Current schema opening, readiness validation, transcript projections, and live-run recovery remain with their runtime owners.

    This migration scans session keys first. If no legacy aliases exist in any candidate store, it reads no transcripts; otherwise, it streams only the aliases and their normalized targets across those stores. Cross-store copies reread and verify the source before writing, and source deletion verifies it again inside the deleting transaction. This bounds transcript memory during Doctor, including the Doctor pass inside `openclaw update`. Gateway startup leaves the legacy migration and its scans to Doctor.

    Standalone SDK installations from 2026.9.x keep using the nonempty legacy `~/.openclaw/agent/` directory under the OS home until Doctor records a completed migration, even if the configured directory already exists. This source ignores `OPENCLAW_STATE_DIR` and `OPENCLAW_HOME`, matching the shipped SDK. Doctor merges that source and any distinct `<state>/agent/` payload into the configured destination. After moving or quarantining every SDK legacy entry, Doctor writes `.legacy-agent-dir-migration.json` at the destination, bound to the resolved source and destination paths. A matching receipt lets the SDK use the configured directory if legacy files reappear; Doctor reports and repairs those leftovers. A missing or incomplete receipt keeps the SDK on the nonempty legacy directory. Doctor preserves an unrecognized destination receipt and reports it for inspection instead of overwriting it. Doctor and the standalone SDK resolve the same install directory from the loaded configuration, including a custom `agentDir` or a non-main default agent. SDK directory reads use an explicit `OPENCLAW_AGENT_DIR` before inspecting config. Otherwise, a missing, unreadable, or invalid config produces one warning and uses the default directory decision, including unmigrated legacy state. Inspection never rewrites config, changes the process environment, or runs migrations; Doctor retains its separate config-admission checks. Explicit `OPENCLAW_AGENT_DIR` overrides remain authoritative for both: Doctor never drains the selected directory, and merges other legacy sources into it. Managed-tool lookup follows this directory when configuration or migration changes it. Copied-state planning defers SDK home payloads outside the bound snapshot; run Doctor on the original installation to migrate those files.

    Without an ambient agent owner or a selected install directory, search tools still use system binaries on `PATH`, and shell commands keep their existing `PATH`. Downloading managed binaries requires selecting an owner or setting `OPENCLAW_AGENT_DIR`; SDK sessions retain their explicit owner requirement.

    The SDK pairs the selected directory with its recorded database owner. A legacy `main` store still opens as `main` when configuration selects another agent, such as `worker`. Doctor defers that directory migration, leaves the store in place, and records `outcome=deferred` with reason `owner-mismatch`, the recorded and configured owners, and the source path. The warning tells you to keep using the existing store; whole-store ownership transfer requires a later release. No completion marker is written for a deferred source, and independent repairs continue. SQLite directory migration remains deferred even when the owners match.

    Doctor merges the legacy agent directory recursively, including existing `bin/` directories. Identical files need no quarantine; differing files keep the current destination and preserve the legacy copy under a single `agent.legacy-<timestamp>-<id>` directory directly under the state directory. Recovery copies stay there even when `agentDir` is external or reached through an ancestor symlink; Doctor resolves the filesystem paths before moving them. The warning and repair report name each conflict, and later repairs continue. Repeating Doctor without new conflicting data does not create another quarantine. Doctor reports quarantines older than 30 days with a cleanup hint, including artifacts from the older per-agent location; inspect them before manually removing copies you no longer need. OpenClaw never deletes these recovery artifacts automatically.

    Doctor leaves every SQLite database family in its original location, including its WAL, shared-memory, and rollback-journal files. This applies even when the destination is empty, and to incomplete families missing their database. The warning and repair receipt record `outcome=deferred`, reason `sqlite-family`, the source files, and the planned destination. Keep using the existing store; safe SQLite directory relocation requires a later release. Doctor does not write a completion marker, and the SDK keeps using the legacy directory and its recorded owner.

    For a source containing SQLite, Doctor preserves the other source files too, keeping installed tools and model discovery usable. It copies missing non-database files into the destination, leaves identical files in place, and warns about differing files while preserving both originals. It creates no conflict quarantine for these deferred sources. Independent repairs continue. Sources without SQLite still use the recursive move and quarantine behavior described above.

  </Accordion>
  <Accordion title="3a. Legacy plugin manifest migrations">
    Doctor scans all installed plugin manifests for deprecated top-level capability keys (`speechProviders`, `realtimeTranscriptionProviders`, `realtimeVoiceProviders`, `mediaUnderstandingProviders`, `imageGenerationProviders`, `videoGenerationProviders`, `webFetchProviders`, `webSearchProviders`). When found, it offers to move them into the `contracts` object and rewrite the manifest file in-place. Repeating this migration has no additional effect; if `contracts` already has the same values, the legacy key is removed without duplicating data.
  </Accordion>
  <Accordion title="3b. Legacy cron store migrations">
    Doctor repairs supported historical shapes in SQLite cron rows and imports supported `jobs-quarantine.json` sidecars. Retired `jobs.json`, `jobs-state.json`, and `runs/*.jsonl` files require an intermediate upgrade through `2026.9.7`; Doctor preserves them and stops before cron repair. See the [retention policy](/gateway/doctor/config-migrations#retention-policy).

    Current cron cleanups include:

    - `jobId` → `id`
    - `schedule.cron` → `schedule.expr`
    - top-level payload fields (`message`, `model`, `thinking`, ...) → `payload`
    - top-level delivery fields (`deliver`, `channel`, `to`, `provider`, ...) → `delivery`
    - payload `provider` delivery aliases → explicit `delivery.channel`
    - legacy `notify: true` webhook fallback jobs → explicit webhook delivery from the retired raw `cron.webhook` value when valid; announce jobs keep their chat delivery and get `delivery.completionDestination`. Doctor then removes the old config key. Without a usable legacy webhook, the inert top-level `notify` marker is removed for no-target jobs (existing delivery, including announce, is preserved) since runtime delivery never reads it.

    Legacy default-agent ownership is repaired only by Doctor. Gateway startup
    leaves stored cron ownership unchanged. An ownerless job whose config still
    retains a legacy default marker waits for repair without consuming its due
    occurrence or disabling a one-shot. Manual runs return `openclaw doctor --fix`
    guidance; explicitly owned jobs continue normally. Doctor pins the historical
    owner before removing that marker, preserving the job's definition and runtime
    state. Unresolved historical jobs also require Doctor before updates or removal,
    and the current system agent does not gain management access to them. Operator
    inspection remains available. For a legacy `agents.list` without a default
    marker, Doctor pins historical ownerless jobs to the first agent in the list
    before converting the roster. Current keyed `agents.entries` configurations
    without a legacy marker keep their dynamic system-agent selection.

    Missing interval anchors are repaired by Doctor. Runtime scheduling can
    calculate the next run without writing an anchor into an old definition.
    Schedule maintenance and run outcomes preserve stored ownership and authored
    fields; intentional enable/disable transitions change only the enabled field.

    The Gateway also sanitizes malformed cron rows at load time so valid jobs keep running. Malformed rows are quarantined in the shared SQLite state database in the same transaction that removes them from active scheduling; doctor reports those records and imports any `jobs-quarantine.json` sidecars left by older releases.

    Gateway startup normalizes the runtime projection and ignores the top-level `notify` marker, but leaves persisted cron state for doctor repair. Doctor removes inert markers for jobs with no migration target (`delivery.mode` none/absent, an unusable legacy webhook target, or existing announce/chat delivery), leaving existing delivery untouched, so repeated `doctor --fix` runs no longer re-warn about the same job.

    On Linux, doctor also warns when the user's crontab still invokes legacy `~/.openclaw/bin/ensure-whatsapp.sh`. That host-local script is not maintained by current OpenClaw and can write false `Gateway inactive` messages to `~/.openclaw/logs/whatsapp-health.log` when cron cannot reach the systemd user bus. Remove the stale crontab entry with `crontab -e`; use `openclaw channels status --probe`, `openclaw doctor`, and `openclaw gateway status` for current health checks.

  </Accordion>
  <Accordion title="3c. Session lock cleanup">
    Doctor scans every agent session directory for legacy write-lock files left behind when a file-backed session exited abnormally. For each lock file found it reports: the path, PID, whether the PID is still alive, lock age, and whether it is considered stale (dead PID, malformed owner metadata, older than 30 minutes, or a live PID proven to belong to a non-OpenClaw process). In `--fix` / `--repair` mode it removes locks with dead, orphaned, recycled, malformed-old, or non-OpenClaw owners automatically. Old locks still owned by a live OpenClaw process are reported but left in place so doctor does not cut off an active transcript writer.
  </Accordion>
  <Accordion title="3d. Session transcript branch repair">
    Doctor scans legacy agent session JSONL files for the duplicated branch shape created by the 2026.4.24 prompt transcript rewrite bug: an abandoned user turn with OpenClaw internal runtime context plus an active sibling containing the same visible user prompt. In `--fix` / `--repair` mode, Doctor repairs the branch while staging its history for import into SQLite. The raw JSONL file stays unchanged and is archived after successful import.
  </Accordion>
  <Accordion title="4. State integrity checks (session persistence, routing, and safety)">
    The state directory is the operational brainstem. If it vanishes, you lose sessions, credentials, logs, and config unless you have backups elsewhere.

    Doctor checks:

    - **State dir missing**: warns about catastrophic state loss, prompts to recreate the directory, and reminds you that it cannot recover missing data.
    - **State dir permissions**: verifies writability; offers to repair permissions (and emits a `chown` hint when owner/group mismatch is detected).
      Config repairs, including during updates, preserve a writable state root owned by another user (for example a Kubernetes `fsGroup` volume with mode `2775`). They report its path, owner IDs, and retained mode as a warning. Config and backup files still require mode `600`; owned-directory hardening and private credential directory checks remain enforced.
    - **macOS cloud-synced state dir**: warns when state resolves under iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs/...`) or `~/Library/CloudStorage/...`, because sync-backed paths can cause slower I/O and lock/sync races.
    - **Windows cloud-synced state dir**: warns when state resolves under a OneDrive sync root (from `OneDrive`, `OneDriveConsumer`, or `OneDriveCommercial`), because sync-backed paths can cause slower I/O, lock/sync races, and Files On-Demand dehydration. To relocate, stop the Gateway, move the whole state directory, set `OPENCLAW_STATE_DIR` for the Gateway service (not just one shell), restart, and rerun doctor.
    - **Linux SD or eMMC state dir**: warns when state resolves to an `mmcblk*` mount source, because SD/eMMC-backed random I/O can be slower and wear faster under session and credential writes.
    - **Linux volatile state dir**: warns when state resolves to `tmpfs` or `ramfs`, because sessions, credentials, config, and SQLite state (with WAL/journal sidecars) disappear on reboot. Docker `overlay` mounts are intentionally not flagged because their writable layers persist across host reboots while the container remains.
    - **Session directory permissions**: checks existing session and store directories for writability. Missing archive directories are healthy on fresh profiles and are created when needed.
    - **Legacy transcript mismatch**: warns when recent legacy session entries have missing transcript files. SQLite-owned sessions do not require archived JSONL files.
    - **Legacy main session "1-line JSONL"**: flags when an unimported main transcript has only one line (history was not accumulating).
    - **Multiple state dirs**: warns when the active state directory differs from the effective home's default `~/.openclaw` directory and that default exists (history can split between installs). The effective home honors `OPENCLAW_HOME`, `HOME`, and `USERPROFILE`; Doctor does not enumerate other accounts' home directories.
    - **Remote mode reminder**: if `gateway.mode=remote`, doctor reminds you to run it on the remote host (the state lives there).
    - **Config file permissions**: warns if `~/.openclaw/openclaw.json` is group/world readable and offers to tighten to `600`.

  </Accordion>
  <Accordion title="5. Model auth health (OAuth expiry)">
    Doctor inspects OAuth profiles in the auth store, warns when tokens are expiring/expired, and can refresh them when safe. If the Anthropic OAuth/token profile is stale, it suggests an Anthropic API key or the Anthropic setup-token path. Refresh prompts only appear when running interactively (TTY); `--non-interactive` skips refresh attempts.

    When an OAuth refresh fails permanently (for example `refresh_token_reused`, `invalid_grant`, or a provider telling you to sign in again), doctor reports that re-auth is required and prints the exact `openclaw models auth login --provider ...` command to run.

    Doctor also reports auth profiles that are temporarily unusable due to short cooldowns (rate limits/timeouts/auth failures) or longer disables (billing/credit failures).

    Doctor also imports legacy generated provider catalogs (`plugins/*/catalog.json` and retained migration claims) into agent SQLite while preserving provider credentials. Run `openclaw doctor --fix` to import these catalogs or repair persisted generated models whose transport API cannot be derived. Ordinary model loading reads stored SQLite catalogs without importing sidecars or repairing saved rows. Initial disk discovery and explicit registry refresh report legacy catalogs with a Doctor command; hot model lookups and lifecycle-captured catalogs do not inspect legacy files. Newly generated catalogs are still normalized before publication.

    OAuth credential sidecar imports are retired. Doctor leaves their files and encryption keys untouched. When a legacy `auth-profiles.json` still references a sidecar, Doctor refuses the migration: upgrade through `2026.9.7` and run `openclaw doctor --fix` from an interactive terminal on the original host before retrying; that release can recover the historical key and import the credentials. Unreferenced sidecars stay in place without blocking. See [retention policy](/gateway/doctor/config-migrations#retention-policy).

  </Accordion>
  <Accordion title="6. Hooks model validation">
    If `hooks.gmail.model` is set, doctor validates the model reference against the catalog and allowlist and warns when it will not resolve or is disallowed.
  </Accordion>
  <Accordion title="7. Sandbox image repair">
    When sandboxing is enabled, doctor checks Docker images and offers to build or switch to legacy names if the current image is missing.
  </Accordion>
  <Accordion title="7b. Plugin install cleanup">
    Doctor repairs legacy official ClawHub install records that predate recorded source authority. With `--fix`, it backfills the existing official host/channel fields only when the original spec and every recorded package identity agree with the official catalog. Local sources, partial or conflicting authority, and unverifiable identities require reinstalling to obtain trust for restricted runtime capabilities. Ordinary legacy npm records with a consistent official spec already satisfy trust. Plugin-scoped state and ingress queues do not require trusted provenance. See [Plugin runtime trust refused](/tools/plugin#plugin-runtime-trust-refused) for refusal reason codes and remedies.

    When a local Gateway is unreachable, doctor compares the CLI state directory with the installed service's effective environment. It prints both paths when they differ, or reports that the service paths could not be verified. Unreadable or commandless service definitions and unavailable referenced environment files are unknown, not evidence that the paths match. Windows batch assignments with unresolved variable expansion or unsupported escaping also remain unverified; inspect their service environment with `openclaw gateway status --deep` before choosing a repair. Run inspection and repair with the Gateway's `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`; matching config and executable versions alone does not establish matching plugin installation state.

    If an unreadable native definition also blocks installation or self-update, follow [native service recovery](/cli/gateway#recover-an-unreadable-native-service-definition). Preserve service-only environment values before rebuilding the launcher; configuration and plugin state do not need to be deleted.

    Doctor preserves shared plugin runtime caches and staging directories, including older versioned buckets. Another installation or profile can still depend on them; a directory name or marker does not establish that it is unused. `openclaw doctor --fix` / `openclaw doctor --repair` removes global plugin-runtime symlinks only when their targets no longer exist, not merely because they point into an older cache.

    The `core/doctor/legacy-plugin-dependencies` lint selector shipped in v2026.8.1 remains available as a deprecated, non-destructive informational check. It no longer scans cache roots or recommends deleting them. Use `--severity-min info` to display its deprecation notice.

    Package-local cleanup remains with the package installer. Doctor still removes orphaned or recovered managed npm copies of bundled `@openclaw/*` plugins that can shadow the current bundled manifest. It also relinks the host `openclaw` package into managed npm plugins that declare `peerDependencies.openclaw`, so package-local runtime imports such as `openclaw/plugin-sdk/*` keep resolving after updates or npm repairs.

    Doctor can also reinstall missing downloadable plugins when config references them but the local plugin registry cannot find them (material `plugins.entries`, configured channel/provider/search settings, configured agent runtimes). During package updates, doctor avoids reinstalling plugin packages while the core package is being swapped; run `openclaw doctor --fix` again after the update if a configured plugin still needs recovery. Gateway startup and config reload do not run package repair; plugin installs remain explicit doctor/install/update work.

    For an incomplete recorded install, Doctor's reinstall hint preserves the recorded package selector, preferring the resolved version over the original spec. For example: `openclaw plugins install clawhub:demo@1.2.3 --force`. If neither selector was recorded, Doctor explains why it cannot give an exact reinstall command and keeps the generic repair guidance.

    Doctor also refreshes stale official runtime plugins that are bound to the current OpenClaw release cohort. This repair uses the declared current target on the recorded registry and verifies that artifact independently of the old installation. An existing exact npm pin becomes the exact replacement version; ordinary missing-plugin repairs preserve the recorded target and integrity. Capability consent still applies.

    Containerized Gateway startup follows the same readiness boundary as other installations. It validates config, admits supported databases, refreshes current plugin metadata, and checks active plugin payloads. The official image entrypoint runs `openclaw doctor --fix --non-interactive` against the mounted state/config before the default or Compose Gateway command, so routine image upgrades need no separate Doctor pass. Gateway startup itself does not import legacy files, repair plugin packages or links, or record completed legacy migrations. If you override the image entrypoint, run Doctor against the same mounted state/config before starting the Gateway. Supported versioned database opening and native initialization remain part of normal runtime operation.

  </Accordion>
</AccordionGroup>
