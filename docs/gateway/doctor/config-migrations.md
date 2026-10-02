---
summary: "Config normalization, legacy config key migrations, and update-time schema publication"
title: "Config and migration repairs"
read_when:
  - Doctor reports a legacy config key or a failed config migration
  - You are adding or modifying a config migration
---

Checks 0-2 cover config normalization and the legacy config key migrations,
plus how doctor publishes shared-state schema during an update.

Plugin config repairs run in order on private config copies. If a repair throws,
Doctor keeps the config from before that hook, reports the failure, and continues
with the remaining repairs. Warning-only results stay visible without changing
config. Repair the affected plugin, then run `openclaw doctor --fix` again.

## Runtime config migration

Runtime config reads require per-model context budgets and current GitHub Copilot
settings. Doctor migrates retired provider-level `contextTokens` and
`contextWindow` values into explicit model entries, preserves existing per-model
values, and reports agent-level caps that cannot be represented per model. Doctor
also removes `plugins.entries.github-copilot.config.discovery.enabled`; configured
Copilot access refreshes its catalog automatically.

Run `openclaw doctor --fix` before starting with these retired keys. Updates apply
the same transforms before candidate config validation, through the existing
backup and include-aware write flow. Ordinary reads leave the authored values
untouched so Doctor can report and persist the repair.

## Retention policy

OpenClaw supports migrations from formats written by shipped releases on or after
July 1, 2026. Retain a transform whenever a release in that window can still write
its input format. A supported release that preserves a legacy
format when rewriting existing data also counts as a writer. A format last
written before the cutoff may be retired only with a clear refusal naming an
intermediate release to upgrade through before retrying. Retirement must never
silently discard persisted data.

Legacy normalization belongs to Doctor and migration owners, with the existing
backup and verification flow. Runtime readers consume canonical state.

Old `openclaw.extension.json` npm declaration stubs are ignored by discovery and
Doctor. They are not plugin manifests, and their files remain unchanged. Reinstall
the package with `openclaw plugins install npm:<package>` and update any explicit
`plugins.load.paths` entry to the installed plugin root. To use the old automatic
stub repair, run `openclaw doctor --fix` on `2026.9.7` before upgrading. Current
`openclaw.plugin.json` manifests and npm package installation remain supported.

OpenClaw `v2026.9.7` can still write ownerless and mode-less cron jobs, and its
migration/import writers can preserve null, `deliver`, or mixed-case delivery
modes. Those cron repairs remain supported; this change retires no cron format.

Doctor refuses these retired inputs:

- `agents.defaults.llm`, agent `embeddedPi`, `embeddedHarness`, whole-agent
  `agentRuntime`, `systemPromptOverride`, and `sandbox.perSession`.
- Agent and surface `silentReplyRewrite` and `silentReply.direct`.
- Agent `model.timeoutMs` and `subagents.model.timeoutMs`, including defaults.
  Timeouts on tool-model selectors remain supported.
- `memorySearch.store.path`, including its agent and `memory.search` forms.
- `plugins.installs`, `gateway.webchat`, `session.parentForkMaxTokens`,
  `browser.relayBindHost`, and `browser.ssrfPolicy.allowPrivateNetwork`.
- Queue modes `queue`, `steer-backlog`, and `steer+backlog` in `messages.queue.mode`
  or `messages.queue.byChannel`.
- Top-level `heartbeat`, `routing.allowFrom`, and `routing.groupChat`.
- `channels.telegram.requireMention`, `channels.feishu.accounts.<id>.botName`,
  and the retired `channels.webchat` section.
- `session.threadBindings.ttlHours` and Discord/LINE/Matrix/Telegram `threadBindings.ttlHours`,
  including per-account settings.
- Telegram `dm`, `direct.*.threadReplies`, native draft preview settings, and scalar
  or flat streaming settings (`streamMode`, `chunkMode`, `blockStreaming`,
  `blockStreamingCoalesce`, and `draftChunk`), including account overrides.

Configs containing these keys must be repaired before current validation can
succeed. Doctor preserves the config and stops with recovery guidance instead
of stripping these settings or replacing them with a backup. For an older installation,
[upgrade through `2026.9.5`](/install/updating#upgrading-very-old-versions)
and run its Doctor migrations before installing the latest version.

## Cron ownership before roster migration

Before retiring a legacy agent roster's default marker, Doctor pins ownerless
cron jobs to that historical agent. This also applies when a different system
agent is selected. Explicit job owners and agent-qualified session keys remain
unchanged. Doctor saves a verified SQLite backup and rechecks the stored owner
and definition before committing. If ownership cannot be repaired, it preserves
the roster marker and reports the condition to resolve.

When legacy import or delivery normalization precedes ownership repair, each
stage saves its own verified snapshot. The earliest backup preserves the original
persisted cron definitions, ownership, and runtime state; the later backup also
includes imported jobs before their owners are pinned. Archived legacy JSON keeps
its original bytes.

An owner recorded only in the SQLite owner column is copied into the job's
canonical definition by Doctor. Its agent identity and runtime state stay the
same; a different system-agent selection does not override it.

Ordinary config writes do not repair cron ownership. A roster change that would
lose the historical owner is refused with `openclaw doctor --fix` guidance.
Run Doctor before updating or removing an unresolved historical job. Agent-scoped
management does not inherit these jobs from the currently selected system agent;
operators with unrestricted session access can still inspect them. Restricted
profile and agent views wait for `openclaw doctor --fix` when ownership is
unresolved; runtime does not infer sharing permission from a legacy SQL owner or
default marker. Explicit creator and agent-qualified session ownership keep their
existing sharing checks. Deleting another agent leaves unresolved rows intact.
The normal `openclaw update` Doctor phase performs this repair before saving
the migrated config, including its early preflight and include-recovery writes.
During the earlier update rehearsal, Doctor can import and normalize cron rows in
the private database copy. It preserves uncopied legacy files, including linked
state, quarantine, and run-log files, and reports their deferred archival. The
live Doctor phase imports those sources and archives them after package installation. This
also protects updates started by supported older releases.

## Legacy cron delivery settings

A stored delivery object must name its mode: `none`, `announce`, or `webhook`.
Doctor repairs a missing or null mode and the retired `deliver` value to
`announce`. It also trims and lowercases recognized modes. Unknown modes stay
unchanged with guidance to review the intended route.

The scheduler keeps unrepaired jobs visible and reports `openclaw doctor --fix`;
it withholds their execution while healthy jobs continue. Doctor repairs known
legacy values. For an unknown value, explicitly edit the delivery mode after
reviewing the intended route. Unrelated edits cannot silently discard it.
Wholly omitted delivery still uses the job's normal defaults; optional failure
notification fields still inherit their configured defaults.

Gateway `cron.add` and `cron.update` requests still accept the deprecated
`delivery.mode: "deliver"` spelling and persist `announce`. Clients should send
`announce`. This request adapter does not repair stored `deliver` values; those
still require Doctor.

## Channel ownership during an update

When Doctor migrates a legacy `agents.list` roster without a `default: true` marker
to explicit ownership, it also preserves unbound accounts with a binding to the first
agent from the old list, which received their implicit traffic before the
update. Existing account bindings and narrower conversation routes remain unchanged. Doctor
reports each added binding and saves it with the roster migration through the
normal config backup and validation flow.

Update-channel migration and manual `openclaw doctor --fix` use the original
roster from the config snapshot. A narrower conversation route never establishes
account-wide ownership. If the original roster is unavailable, Doctor reports
`unresolved: original roster unavailable` with the exact binding to add and leaves
the account's bindings unchanged. An unresolved account stays blocked
with that reason while the Gateway and other accounts continue running; it does
not enter a restart loop. Add the reported binding and restart the Gateway.

## Sender tool policies

Doctor migrates unprefixed `toolsBySender` keys to `id:` entries before config
validation, including the update-time Doctor pass. It preserves the previous
matching behavior: a leading `@` on an unprefixed key is removed, IDs match
without regard to case, and the first configured policy wins when multiple keys
normalize to the same ID. Doctor reports shadowed entries and preserves their
original values in the normal config backup before saving the repair.

Runtime config requires typed sender keys or `"*"`. After replacing the binary
directly, run `openclaw doctor --fix` before starting the Gateway. Explicit
`id:@user:server` policies and incoming sender-ID matching remain supported.

## Channel webhook listeners

Feishu, Nextcloud Talk, and Telegram receive webhooks on Gateway HTTP routes. Their plugin-owned
Doctor migrations move an explicitly configured `webhookPort` and effective bind host
into `legacyWebhook: { port, host? }`. An explicit host without a port keeps that
host with the channel's previous port (`3000` for Feishu, `8788` for Nextcloud Talk,
`8787` for Telegram).
Doctor validates and backs up the config through the normal write flow. The
compatibility listener forwards only its registered webhook
routes through the same Gateway request pipeline, preserving signatures and retry
responses during channel restarts.

The exported Feishu, Microsoft Teams, Nextcloud Talk, and Telegram config types
retain deprecated listener input properties (`webhookPort`, `webhookHost`, or
`webhook.port`) until the next Plugin SDK major. TypeScript config producers remain
source-compatible, but parsed runtime config uses only `legacyWebhook`; run Doctor
before using legacy inputs. This type compatibility window does not schedule
removal of the default listener.

Update the external callback or reverse-proxy upstream to the Gateway port and
the channel's webhook path, verify delivery, then set `legacyWebhook: false` to
close the old port. Omitting `legacyWebhook` preserves Feishu's previous
`127.0.0.1:3000` listener, Nextcloud Talk's `0.0.0.0:8788` listener, or Telegram's
`127.0.0.1:8787` listener while webhook transport is active.
An explicit object selects its configured endpoint;
an account-level value overrides the
channel-level setting. Doctor explains the canonical Gateway route and opt-out
without changing implicit settings. A shared compatibility port closes when no
account retains that endpoint.

This behavior is the same for existing and new installations. It needs no upgrade
eligibility check or migration receipt. Removing `legacyWebhook: false` restores
the default listener; removing an explicit object also returns to the default.
Retiring these listeners is a separate future change, with no removal deadline
or automatic expiry introduced here.

Telegram re-registers its configured public `webhookUrl` at startup. It preserves
that URL because its reverse-proxy upstream cannot be inferred safely. Accounts
that shared a path and secret on different explicit ports keep their old-port
routing; assign distinct secrets or paths before moving them to one Gateway port.

A separately installed Telegram plugin on the 2026.9.6 host performs the same config migration, but the host predates Gateway-owned forwarding. Telegram retains the predecessor's direct per-account listener there; accounts need distinct legacy endpoints. Doctor places the listener guidance in its supported warning output and identifies this limitation. On newer hosts, the shared Gateway listener and informational notes remain unchanged.

Microsoft Teams uses the same owner: Doctor moves explicit
`channels.msteams.webhook.port` to `channels.msteams.legacyWebhook.port`, preserving
`webhook.path`. Omitted listener settings retain port `3978` with its previous
wildcard bind. After verifying the Azure Bot endpoint through the Gateway port,
set `channels.msteams.legacyWebhook: false` to close the compatibility listener.
Teams keeps its Express body parser and SDK authentication on both listeners.

## Talk realtime inheritance

Doctor copies previously inherited Voice Call realtime provider settings into
`talk.realtime` through its normal validated, backed-up config write. Explicit
Talk settings win, including whole provider blocks and a sole configured Talk
provider. SecretRefs remain references. Voice Call's own realtime and streaming
settings stay unchanged for telephony and Talk transcription.

After repair, realtime Talk reads only `talk.realtime`; changing Voice Call
settings no longer changes Talk sessions. A sole migrated provider follows Talk's
normal single-provider selection rule. Doctor fills missing Talk provider settings
when the Voice Call inputs remain, and repeated repair is unchanged until those
inputs or missing destinations change. This repair also runs during updates driven
by a published updater that invokes Doctor without `--fix`.
Voice Call-only settings remain valid configuration. Doctor detects this pending
inheritance repair independently of schema errors; ordinary config reads never
copy the settings into Talk.

## ACP agents' model precedence

For an agent with `runtime.type: "acp"`, `agents.entries.*.model` (string form) or
`agents.entries.*.model.primary` (object form) selects the ACP harness model. This
also applies to harness selections that look like `provider/model` references.
OpenClaw resolves a separate native default, using `agents.defaults.model` when
configured. Explicit native session, utility, and subagent model selections retain
their precedence.

Doctor reports this separation as information (`core/doctor/acp-agent-model`),
naming the configured path, harness model, and resolved native default. Matching
and differing selections are both supported configurations. This notice proposes
no repair and does not rewrite the config; ACP turns keep their configured harness
selection.

## Missing plugins during migration

A configured plugin that is missing or cannot finish installation does not block
Doctor, updates, or Gateway startup. OpenClaw records a warning that names the
plugin, its pending migration, and the command to finish installation or repair.
The Gateway continues serving the available plugins.

`doctor --fix` repairs an older shared database schema before recording pending
plugin migrations. Missing plugins therefore do not prevent the database repair;
their inputs stay available for a later retry.

Deferred migrations keep their state and legacy config inputs in place. Config
repairs can still update unrelated settings, while the pending plugin's retired
fields remain inactive. After installing or repairing the plugin, run
`openclaw doctor --fix` to complete its migration and clear the pending warning.
During an update driven by an older version, plugin installation can remain
deferred until that updater finishes; its pending inputs receive the same
protection.
Session edits and deletions made after the core import remain authoritative when
the plugin migration resumes.

While a migration is pending, explicit config edits that would change or remove
its retained inputs are refused with the recovery command. Unrelated settings
remain writable. Complete the plugin migration before editing those inputs.

## Retired TaskFlow Webhooks plugin

The bundled TaskFlow Webhooks plugin has been removed. Existing
`plugins.entries.webhooks` settings are ignored with a `plugin removed: webhooks`
warning so the Gateway can start after an update. Run `openclaw doctor --fix` to
remove its stale entry and `plugins.allow` or `plugins.deny` references through
the normal config backup and repair flow. This retirement does not change the
database schema or delete stored Tasks or TaskFlows.

If Webhooks was the only plugin in `plugins.allow`, Doctor retains other
already enabled plugins as explicit allowlist entries, including configured
bundled channels and selected memory or context-engine plugins. Existing deny
and disable settings still apply. Doctor reports the retained IDs; review this
list when changing channels or plugin slots because these entries remain explicit
plugin permissions.

If no enabled plugins remain, Doctor sets `plugins.enabled: false`. An empty
allowlist would otherwise allow unrelated installed plugins to load. Review the
remaining plugin choices, set `plugins.allow` to the plugins you want, and then
re-enable plugins.

If an active plugin's legacy ID aliases to a different owner, Doctor leaves the
stale plugin settings unchanged and warns instead of granting that other owner
access. Choose noncolliding allowed plugin IDs, then rerun `openclaw doctor --fix`
to finish cleanup. Other Doctor repairs continue.

Use [Gateway HTTP hooks](/automation/cron-jobs/webhooks) to wake an agent or submit
an agent turn from an external service. Their `hooks.*` settings, internal event
hooks, and the `openclaw webhooks gmail` commands remain available. TaskFlow
record actions from the retired plugin have no equivalent HTTP endpoint.

## Schema publication during a 2026.9.2 update

When OpenClaw 2026.9.2 drives an update that needs a newer shared-state schema,
Doctor applies the migration content and reports
`schema content applied; version publication deferred until update run <id> finishes`.
The old updater can finish its ledger access, while the new Gateway uses the
migrated content. Publication waits until all affected terminal runs are at least
five minutes old; a running row unchanged for more than 30 minutes counts as
abandoned. Every writable database open follows this rule, and the Gateway
watcher schedules publication after the deadline.

Ordinary CLI commands, including Doctor, remain usable while that Gateway runs.
Applied content counts as ready; only the owning Gateway, or a writable opener
when no Gateway owns the state directory, publishes the version after the grace.

Agent-database migrations are not version-deferred. During the published 2026.9.2
updater's rollback window, Doctor validates private state copies and leaves the
live databases and config unchanged. After package rollback is no longer possible,
the fresh update continuation requires a verified backup covering each pending
agent database and current update ownership before Doctor migrates the live state.
Managed updates retain the shipped helper's original handoff record unchanged.

Doctor reports `update-schema-bump-unfenced` when this handoff cannot be verified,
backup coverage is missing, the required shared-state metadata table is absent,
or a migration fails. Follow the
[manual update sequence](/install/updating#updating-from-2026.9.2-across-a-schema-bump)
from the refusal. See [Database schemas](/reference/database-schemas#schema-bumps-and-older-updaters)
for the publication contract and the remaining risk for an old CLI stalled
beyond the grace period.

## Native Codex recovery after Tasks removal

The Codex plugin's `codex-native-task-assignments` Doctor migration preserves
recoverable native child work when upgrading from the Tasks runtime. It runs
through the existing plugin state-migration lifecycle, including update-time
Doctor. After a direct binary replacement, run `openclaw doctor --fix` before
starting the new Gateway.

During maintenance, Doctor reads a snapshot of
`~/.openclaw/state/openclaw.sqlite` and selects legacy `task_runs` records with
`runtime = 'subagent'` and `task_kind = 'codex-native'`. It imports only uniquely
identified, unacknowledged work whose `nativeHistory` owner stamp matches the
current requester's physical session, lifecycle revision, and Codex connection.
These ownership stamps are already present in published 2026.9.4 state.
The original native parent may differ
after native thread rotation, but rotation cannot supply missing requester
ownership. Initial children and follow-ups already promoted into Task rows keep
their exact child and turn locators. A persisted terminal summary, status, and
completion time remain available when native history no longer contains the
result.

Terminal deliveries marked `failed` after exhausting their retry budget remain
historical and are not automatically restarted.

The migration writes `nativeSubagentAssignments` and the per-source Task ID
marker `nativeSubagentTaskImport` together in one compare-and-apply operation on
the existing `app-server-thread-bindings` plugin state. A changed binding is
preserved and reported for retry. Acknowledgement can consume the assignment,
while the import marker survives acknowledgement, native rotation, clear, and
reset so unchanged legacy rows cannot resurrect completed work. The shared
database is declared in the migration's backup inventory; every source Task row
remains byte-identical. There is no new SQL table, schema-version bump, Tasks
runtime reader, or replacement Task ledger. Native execution and completion
delivery continue to require current requester authority.

Unstamped records, including 2026.9.2-era rows, cannot establish the missing
physical requester and connection history. Doctor also preserves ambiguous
duplicate run IDs and records whose ownership no longer matches. It emits a
recoverable warning identifying the Task and native run, without disabling the
Gateway or unrelated sessions. Inspect the child in its original native Codex
account, or restore the pre-update backup with its matching OpenClaw version to
finish delivery. After resolving a repairable binding conflict, run
`openclaw doctor --fix` again. The migration does not guess ownership from the
current parent alone.

## Replay a July 2026 config upgrade

From a source checkout with its pnpm dependencies installed, run:

```bash
node scripts/doctor-config-upgrade-replay.mjs
```

The driver runs with plain Node and imports only Node built-ins. It requires
the checkout's fixture and `pnpm openclaw` build wrapper; an installed npm
package alone cannot run this replay. No `tsx` invocation is needed for the driver.

The replay uses the synthetic `test/fixtures/doctor-2026.7.1.json` config. It
builds through `pnpm openclaw`, isolates the home, state, config, and logs under
`.local`, and selects free loopback ports. It captures validation before repair,
two `doctor --fix --non-interactive` passes, validation after the first pass,
and Gateway startup. It keeps the original config, both repaired copies, and
command output in the printed directory. The second pass must leave the config
bytes unchanged. It never needs credentials or a running Gateway.

A second fixture covers `messages.tts` moving to `tts` before retired TTS fields
are removed. Doctor preserves the old preference-file path in shared machine
state before removing `prefsPath`; existing canonical settings and stored state
keep precedence, and the preferences file stays intact.

The fixture combines a two-agent `agents.list` roster, the legacy model
allowlist, local memory search, a CLI audio model, Telegram account allowlists,
and the retired `meta.lastTouchedAt`, `gateway.tailscale.resetOnExit`, and
`gateway.nodes.denyCommands` keys. The current media field is optional plural
`capabilities`; Doctor adds `["audio"]` when moving an audio-only model to
`tools.media.models`. A singular `capability` field is not required.

Local embeddings keep the `local` provider and their existing model selection.
The in-process `node-llama-cpp` runtime was replaced by a managed `llama-server`.
When managed setup is missing, Doctor and Gateway startup name the degraded
semantic recall and the plugin's guided setup command:

```bash
openclaw models --agent main auth login --provider llama-cpp --method local
```

Run that command interactively and choose the appropriate managed setup, then
verify with `openclaw memory status --deep`. Setup can offer embeddings without
changing the chat model. Downloads require setup consent. In the July provider,
`memorySearch.model` did not select the local GGUF: `local.modelPath` did.
Doctor therefore preserves both fields instead of silently turning an ignored
model value into a different embedding model. See [llama.cpp](/plugins/llama-cpp).

## Auth credential fields

Doctor owns legacy credential-field conversion in both JSON imports and existing
SQLite auth stores, including stores whose profile IDs already use current
provider names. Field-only SQLite repair saves a private, verified backup and
preserves profile IDs, credential material, unknown metadata, and rotation state.
Malformed credential values and unreadable rotation-state JSON remain intact;
they do not block repairs to supported fields. Alias renames still require valid
complete stores and rotation state. Doctor defers affected config, session, and
personal-account references whenever an owner cannot safely rename its IDs.
An occupied alias destination or changed account receipt defers that mapping
without preventing independent credential-field repairs or safe aliases.

The conversion moves a recognized `mode` to a missing `type`, changes
`type: "apiKey"` to `api_key`, and moves usable `apiKey` or `api_key` values to
`key`. Usable canonical keys and references take precedence; empty or malformed
keys do not discard a usable legacy value. These aliases may also hold SecretRefs.
A SecretRef in the credential type's `key` or `token` moves to the matching
`keyRef` or `tokenRef` only when that reference is missing or invalid. Fields for
other credential types and aliases that did not supply a replacement stay intact.
Doctor removes converted field names, verifies source rows before
committing, and does nothing on a second run. Runtime rejects convertible legacy
fields with `openclaw doctor --fix` instructions. Malformed extras do not prevent
an otherwise valid canonical credential from loading.

JSON import retains its existing canonical projection: recognized credential
types and supported fields enter SQLite, string metadata is retained, and unknown
fields or malformed sibling entries are omitted from the active import. The
original JSON bytes are archived exactly with the existing migration receipt, so
those omitted values remain recoverable. This differs from field-only repair of
existing SQLite rows, which preserves unknown and malformed values in place.

The installed updater invokes candidate Doctor before activation, so the same
conversion runs during an update. Mixed JSON and SQLite stores are normalized
before their credential sets are merged, and supplied alias mappings are checked
against the current SQLite owners before the import can rename profiles.

## Checks 0-2

<AccordionGroup>
  <Accordion title="0. Optional update (git installs)">
    If this is a git checkout and Doctor is running interactively, it offers to update before running its checks. Accepting uses the normal `openclaw update` lifecycle for that checkout, including validation, recovery, and Gateway restart. The source update keeps your saved update channel unchanged. Externally managed installs continue Doctor without offering self-update; update them through their deployment owner.
  </Accordion>
  <Accordion title="1. Config normalization">
    GitHub Copilot now requires explicit provider config, a saved Copilot auth profile, or `COPILOT_GITHUB_TOKEN`. Generic `GH_TOKEN` and `GITHUB_TOKEN` no longer activate it. Doctor reports this change once when only a generic GitHub token is present. The retired `plugins.entries.github-copilot.config.discovery.enabled` setting is ignored during config loading, including malformed values, and removed when Doctor saves the config.

    Doctor normalizes legacy value shapes into the current schema. Current Talk speech config is `talk.provider` + `talk.providers.<provider>`, with realtime voice config under `talk.realtime.*`. Doctor rewrites old `talk.voiceId` / `talk.voiceAliases` / `talk.modelId` / `talk.outputFormat` / `talk.apiKey` shapes into the provider map, and rewrites legacy top-level realtime selectors (`talk.mode`, `talk.transport`, `talk.brain`, `talk.model`, `talk.voice`) into `talk.realtime`.

    Doctor also warns when `plugins.allow` is non-empty and tool policy uses wildcard or plugin-owned tool entries. `tools.allow: ["*"]` only matches tools from plugins that actually load; it does not bypass the exclusive plugin allowlist.

    A tool policy scope with nonempty `allow` and `alsoAllow` lists fails validation. `doctor --fix` merges the lists only when the effective profile grants remain unchanged for every agent and provider that inherits the extras. It retains `alsoAllow: []` as an explicit override so inherited extras cannot reappear. If the extras may extend a profile or grant Gateway configuration-read access, Doctor leaves the conflicting scope untouched and reports the exact keys and values to review manually. This applies at the root `tools` policy, per-agent and per-provider policies, and channel or gateway tool policies. Sandbox lists remain untouched because `allow` and `alsoAllow` inherit independently; conflicting sandbox lists still require manual repair. Plugin-owned `plugins.entries.*.config` is left to the owning plugin's doctor contract. Gateway startup leaves these conflicts unchanged and directs the operator to Doctor; unresolved conflicts still require operator guidance before the config can validate.

    `doctor --fix` removes `workspace: null` from `agents.entries.<id>` so normal workspace resolution can apply. It also removes invalid `heartbeat.activeHours` windows from agent entries and `agents.defaults`, preserving other heartbeat settings. Reconfigure a valid window if needed; without an explicit or inherited window, heartbeat hours are unrestricted. These repairs also apply after migrating a legacy `agents.list` roster.

  </Accordion>
  <Accordion title="2. Legacy config key migrations">
    Ordinary Doctor, including `doctor --non-interactive`, automatically normalizes a legacy single-file config when the shared migration transforms produce a fully valid result. This also covers older npm updaters that invoke Doctor without `--fix`. The planner still requires complete plugin validation. Doctor preserves the original in the config backup ring and keeps state migration ordering intact. Includes, externally managed config, newer-written config, and remaining validation errors require the existing explicit repair or operator recovery path. Updaters that explicitly defer plugin repair or advertise a later writable config handoff keep automatic normalization deferred. This does not enable repair maintenance, service changes, or exec-approval migration without `--fix`.

    Older Git updaters can keep an in-memory config snapshot and write it after Doctor exits. When that parent marks the update in progress without advertising support for Doctor config writes, Doctor preserves the config, including with `--fix`. A supported fresh update continuation runs Doctor before plugin convergence and rereads the repaired config. An older Git updater without that continuation requires `openclaw doctor --fix` after the update; Gateway startup does not finish its legacy repair.

    Gateway and local CLI startup validate current config without rewriting legacy keys. Invalid legacy config remains unchanged and startup prints the `openclaw doctor --fix` hint. An interactive terminal can offer to run Doctor and retry once; headless services stop with the hint. Doctor preserves the original in the five-slot `openclaw.json.bak` / `.bak.1` through `.bak.4` backup ring before writing a validated repair. Includes, externally managed config, newer-written config, and unresolved validation errors retain their existing repair and recovery safeguards.

    Ordinary config recovery can restore an already valid backup without changing its authored bytes. A backup that needs legacy transformations must be recovered through Doctor, which applies the same shared migration transforms before validation and restoration.

    Doctor checks the authored config revision, included files, and environment-resolved values before migration writes. Runtime path expansion (such as `~/.openclaw/wiki` on Windows) does not count as an input change. A real change reports whether the config path, file contents, included files, or resolved values changed; rerun Doctor so migrations can validate the new inputs.

    When model migrations change a configured consumer between subscription/OAuth and metered API-key billing, Doctor reports the consumer, model, and old and new routes after saving the config. The warning also appears in the diagnostic log and update run record. A later Doctor run does not repeat it when the resolved billing route is unchanged. Missing credentials are not treated as proof of a billing change.

    During an update, Doctor records model-retirement repairs that must wait until plugin installation finishes. The updated OpenClaw completes those repairs after plugin convergence, even when no plugin version changed. `openclaw update status` records their completion so retired subscription models do not fall through to metered API credentials.

    Utility-model separation preserves an older config's implicit primary before recording `meta.migrations.utilityModelSeparation: true`. Doctor and normal config writes use the previous config to save that primary explicitly; existing primary selections, fallbacks, and credential bindings stay authoritative. This keeps regular chat available when the old implicit primary also served utility tasks. Fresh utility setup records the separation without choosing a primary, and a provider added during utility setup is not mistaken for the previous primary. See [agent model configuration](/gateway/config-agents/models#agents.defaults.model).

    Other commands that encounter legacy keys still ask you to run `openclaw doctor`. Doctor explains the issues, shows its migrations, and rewrites `~/.openclaw/openclaw.json` with the updated schema. Cron job store migrations are also handled by `openclaw doctor --fix`; automatic config-key migration does not import legacy session stores or repair services.

    When a readable active config can be fully migrated, Doctor preserves it before considering last-known-good recovery. This includes legacy multi-agent rosters with a `default: true` owner: unrelated settings and the original agent ownership survive the migration.

    Per-agent migrations apply to both keyed `agents.entries` and legacy `agents.list` rosters, including rosters that already set `agents.ownership: "explicit"`. For example, Doctor preserves an agent's legacy `memorySearch` settings under `memory.search`. Existing values at the current config paths take precedence.

    For legacy rosters with multiple agents and no resolvable ambient owner, Doctor seeds `agents.defaults.systemAgent.agentId` from a uniquely marked `default: true` agent, or `main` when present. Sole-agent rosters and legacy default markers already honored by the runtime need no owner repair and produce no missing-owner advice. Explicit fleet ownership disables the legacy default-marker fallback, so those rosters may still need repair. Doctor also pins `agents.defaults.heartbeat.agentId` only when heartbeat enrollment would otherwise be unresolved; existing heartbeat owners, shared defaults, and per-agent enrollment are preserved. These changes are reported and saved by `doctor --fix`, including the update-time doctor pass. If no default can be identified, configure the system-agent owner explicitly.

    <Note>
      Migration retention follows the July 2026 cutoff in the
      [retention policy](/gateway/doctor/config-migrations#retention-policy), based
      on which supported releases can still write the format. For a retired
      format, follow Doctor's intermediate-upgrade instructions before retrying.
    </Note>

    Active migrations:

    | Legacy key                                                                                    | Current key                                                                 |
    | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
    | `tools.toolSearch.mode: "code"` | `tools.toolSearch.mode: "tools"` (structured Tool Search) |
    | `tools.toolSearch.codeTimeoutMs` | removed (Tool Search activation is preserved) |
    | `tools.codeMode.runtime: "quickjs-wasi"` (global and per-agent)                                | `tools.codeMode.executor: "quickjs"` (an existing executor selection wins) |
    | `tools.codeMode.languages`, `agents.entries.*.tools.codeMode.languages`                         | removed (Code Mode executes JavaScript; activation and limits are preserved) |
    | legacy `talk.voiceId`/`talk.voiceAliases`/`talk.modelId`/`talk.outputFormat`/`talk.apiKey`        | `talk.provider` + `talk.providers.<provider>`                               |
    | legacy top-level realtime Talk selectors (`talk.mode`/`talk.transport`/`talk.brain`/`talk.model`/`talk.voice`) | `talk.realtime`                                                              |
    | `messages.tts`                                                                                  | top-level `tts`                                                              |
    | `messages.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`)                             | `tts.providers.<provider>`                                                   |
    | `messages.tts.provider: "edge"` / `messages.tts.providers.edge`                                  | `tts.provider: "microsoft"` / `tts.providers.microsoft`                    |
    | `tools.exec.security` + `tools.exec.ask`                                                         | `tools.exec.mode`                                                            |
    | `session.idleMinutes`                                                                            | `session.reset.idleMinutes`                                                  |
    | `messages.responsePrefix` with explicit channel blocks                                           | copied to configured channel/account `responsePrefix`; global fallback retained for implicit/custom channels |
    | `web.enabled`                                                                                    | `channels.whatsapp.enabled`                                                  |
    | `meta.lastTouchedAt`, hook installs, cron store, bundled discovery, global TTS prefs path            | shared SQLite state                                                       |
    | TTS speaker fields `voice`/`voiceName`/`voiceId`                                                 | `speakerVoice`/`speakerVoiceId`                                              |
    | `channels.<id>.tts.<provider>` / `channels.<id>.accounts.<accountId>.tts.<provider>` (all channels except Discord)                                          | `...tts.providers.<provider>`                                                |
    | `channels.<id>.voice.tts.<provider>` / `channels.<id>.accounts.<accountId>.voice.tts.<provider>` (all channels, including Discord)                          | `...voice.tts.providers.<provider>`                                          |
    | `plugins.entries.voice-call.config.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`)     | `plugins.entries.voice-call.config.tts.providers.<provider>`                |
    | `plugins.entries.voice-call.config.tts.provider: "edge"` / `...tts.providers.edge`                | `provider: "microsoft"` / `...tts.providers.microsoft`                      |
    | `plugins.entries.voice-call.config.provider: "log"`                                              | `"mock"`                                                                      |
    | `plugins.entries.voice-call.config.twilio.from`                                                  | `plugins.entries.voice-call.config.fromNumber`                              |
    | `plugins.entries.voice-call.config.streaming.sttProvider`                                        | `plugins.entries.voice-call.config.streaming.provider`                      |
    | `plugins.entries.voice-call.config.streaming.openaiApiKey`/`sttModel`/`silenceDurationMs`/`vadThreshold` | `plugins.entries.voice-call.config.streaming.providers.openai.*`             |
    | `models.providers.*.api: "openai"`                                                               | `"openai-completions"` (gateway startup also skips providers whose `api` is a future/unknown enum value rather than failing closed) |
    | `browser.profiles.*.driver: "extension"` with a stale `cdpUrl`                                  | driver preserved; stale relay URL removed                                     |
    | `mcp.servers.*.type`, `nodeHost.mcp.servers.*.type` (CLI-native aliases)                           | corresponding `transport` field                                            |
    | `mcp.servers.*.disabled`                                                                         | inverse `mcp.servers.*.enabled`                                              |
    | MCP timeout aliases `connectTimeout`/`connect_timeout`/`timeout`                                 | `connectionTimeoutMs`/`requestTimeoutMs`                                    |
    | MCP snake-case server fields                                                                     | camelCase MCP server fields                                                   |
    | `tools.media.image/audio/video.models`                                                           | capability-tagged `tools.media.models`                                        |
    | `tools.media.asyncCompletion`                                                                    | removed                                                                       |
    | `tools.message.allowCrossContextSend`                                                            | `tools.message.crossContext`                                                  |
    | media model `deepgram` options                                                                   | `providerOptions.deepgram`                                                    |
    | `talk.realtime.voice`, Discord realtime `voice`                                                 | `speakerVoice`                                                                |
    | `agents.defaults.pdfMaxBytesMb`                                                                  | `agents.defaults.pdfMaxMb`                                                    |
    | `tools.exec.timeoutSec`                                                                          | `tools.exec.timeoutSeconds`                                                   |
    | `browser.ssrfPolicy.hostnameAllowlist`                                                           | wildcard-aware `browser.ssrfPolicy.allowedHostnames`                          |
    | sandbox browser `enableNoVnc`                                                                    | `noVncEnabled`                                                                |
    | root `media`                                                                                     | `attachments`                                                                |
    | channel/account `heartbeat` visibility blocks                                                   | `heartbeatVisibility`                                                         |
    | `channels.slack.identity`                                                                        | `channels.slack.postAs`                                                       |
    | root `audit`                                                                                     | `logging.audit`                                                               |
    | `gateway.nodes.skills.enabled`                                                                   | `gateway.nodes.allowSkills`                                                   |
    | `gateway.nodes.allowCommands`/`denyCommands`                                                    | `gateway.nodes.commands.allow`/`deny`                                         |
    | generation model defaults                                                                       | `agents.defaults.mediaModels.{image,video,music}`                              |
    | retired final-layout tuning knobs                                                               | built-in default behavior                                                     |
    | `channels.whatsapp.messagePrefix` and legacy `messages.messagePrefix`                            | `channels.whatsapp.responsePrefix`                                            |
    | `channels.whatsapp.ackReaction`                                                                  | global `messages.ackReaction` and `ackReactionScope` where translatable        |
    | `cron.failureDestination`                                                                        | destination fields on `cron.failureAlert`                                     |
    | `gateway.controlUi.chatMessageMaxWidth`, presentation-only `ui.prefs` keys                       | removed (text scale, chat width, and live sidebar activity are browser-local) |
    | `agents.list`                                                                                    | keyed `agents.entries`                                                        |
    | top-level `defaultModel`                                                                         | `agents.defaults.model`                                                      |
    | `session.maintenance.pruneDays`, `session.resetByType.dm`                                        | `session.maintenance.pruneAfter`, `session.resetByType.direct`               |
    | top-level `tui`                                                                                  | removed (the TUI footer uses the compact default)                            |
    | `plugins.entries.codex.config.codexDynamicToolsProfile`                                          | removed (Codex app-server always keeps Codex-native workspace tools native) |
    | `commands.modelsWrite`                                                                           | removed (`/models add` is deprecated)                                       |
    | `agents.defaults.silentReply.internal`, `surfaces.*.silentReply.internal`          | removed (only external channel groups may opt into silent replies)          |
    | top-level `memorySearch`, `agents.defaults.memorySearch`                                         | `memory.search`                                                             |
    | `agents.entries.*.memorySearch`                                                                     | `agents.entries.*.memory.search`                                               |
    | `memorySearch.provider: "auto"`                                                                  | `"openai"`                                                                    |
    | `plugins.openai-codex` policy ids                                                                | `plugins.openai`                                                             |
    | `tools.web.x_search.apiKey`                                                                      | `plugins.entries.xai.config.webSearch.apiKey`                               |
    | `session.maintenance.rotateBytes`                                 | removed (deprecated)                                                        |
    | Runtime and channel tuning knobs retired in 2026.7                                               | removed (built-in production defaults apply)                               |
    | `diagnostics.memoryPressureSnapshot`, legacy `diagnostics.memoryPressureBundle`                  | removed (automatic critical-memory snapshots were retired; no replacement automatic capture) |

    Doctor migrates MCP `type: "http"` to `transport: "streamable-http"` and `type: "sse"` to `transport: "sse"` in both server maps. An existing `transport` wins. For command-based servers, Doctor removes `type: "stdio"`; the command still selects stdio. The update-time Doctor pass uses the same backed-up config repair. Plugin bundle files keep their external `type` format: bundle loading translates recognized types, and CLI exports use the destination's required format. An unknown bundle HTTP transport is rejected instead of being treated as SSE; its original `type` remains available to the destination CLI.

    Code Mode's runtime migration preserves an explicit QuickJS choice in global config, keyed agent entries, and legacy agent rosters. Existing `executor` values win, and activation and limits remain unchanged. Selecting the bundled QuickJS runtime works even when generic plugins are disabled or allowlisted, without enabling other plugins; an explicit deny or disabled entry for `code-mode-quickjs` still blocks it. Configurations that never selected a runtime use the new `node` default. See [Code Mode executors](/tools/code-mode/executors) before enabling Node execution; `node:vm` is not a security boundary.

    Doctor removes retired `silentReply.internal` settings from agent defaults and surface overrides while preserving `silentReply.group`. This repair runs through the normal config backup and validation flow, including update-time Doctor. Direct chats and internal sessions, including subagents, require a result; only external channel groups can opt into `NO_REPLY`.

    Doctor names the retired tuning paths it actually removes in one notice, including explicit `false` values: `Removed retired runtime tuning knobs: diagnostics.memoryPressureSnapshot; built-in defaults now apply.` Run `openclaw doctor --fix` before starting with these retired keys. Memory-pressure events remain available; use [diagnostics export or manual allocation profiling](/gateway/diagnostics) for current evidence.

    <Note>
      The Voice Call plugin supplies the migration for its legacy config keys.
      `openclaw doctor --fix` invokes it and persists the canonical shape in
      `openclaw.json`; runtime config parsing accepts only current keys.
      Existing canonical settings win over legacy values, including streaming
      provider credentials, models, and timing. Doctor reports retained
      destinations instead of claiming those legacy values were moved.
    </Note>

    Per-agent `memorySearch` migrations work with both old `agents.list` rosters and keyed `agents.entries`. Doctor preserves explicit `memory.search` settings when merging legacy values, including environment references moved to the new paths. When repairs affect only per-agent settings, single-file agent includes stay in their included file.

    When model-policy migration accompanies an agent repair in the same included file, Doctor keeps the explicit policy and repaired settings in that file. A policy-only repair can target a deeper defaults include without rewriting its parent files. Existing include ownership, backup, and conflict checks still apply.

    The retired `tools.message.allowCrossContextSend` flag migrates at both root and per-agent scopes. Doctor preserves the effective cross-context permissions, including an agent's `false` override of a root `true` flag.

    Account-default guidance for multi-account channels:

    - If two or more `channels.<channel>.accounts` entries are configured without `channels.<channel>.defaultAccount` or `accounts.default`, doctor warns that fallback routing can pick an unexpected account.
    - If `channels.<channel>.defaultAccount` is set to an unknown account ID, doctor warns and lists configured account IDs.

    In multi-agent configs, `doctor --fix` preserves the historical account owner
    from the original legacy roster. Existing routes remain unchanged. Accounts
    without historical ownership evidence need an explicit binding; Doctor never
    promotes a narrower conversation route to account-wide ownership.

  </Accordion>
</AccordionGroup>
