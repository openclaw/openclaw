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

Doctor keeps plugin repair and diagnostic contracts available through later health
checks and service finalization. It releases its private plugin resources when
the flow ends, including failed runs.

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

## Direct Ollama Cloud routing

Older Cloud-only setup stored hosted Ollama models under `models.providers.ollama`.
When that provider points to `https://ollama.com`, Doctor moves it to
`ollama-cloud` and rewrites its model references in agent defaults, model
allowlists, per-agent settings, heartbeat, utility, subagent and compaction
models, cron jobs, and session overrides. URL paths and trailing slashes do not
change the hosted classification. An existing `ollama-cloud` catalog keeps its
models and gains missing migrated models without duplicates.
Role model-policy allow and deny rules move together, preserving restrictions.

Localhost, LAN, and custom endpoints stay unchanged, including cloud models
served through a signed-in local Ollama daemon. Other provider keys also stay
unchanged. Doctor does not infer hosted routing from a model name.

Both providers use `OLLAMA_API_KEY`, so environment-backed URLs, credentials, and
SecretRefs keep their authored references without a credential-store migration.
Doctor leaves saved `ollama` auth profiles untouched; if the key exists only in
that saved profile, run `openclaw onboard --auth-choice ollama-cloud` to configure
Cloud authentication.

Migrated model references drop their `@profile` suffix rather than moving an
account pin across providers. Doctor emits one reminder to re-pin with
`/model <provider/model>@<profile>` if needed. Saved credentials are not modified.

Run `openclaw doctor --fix` to apply the migration. Updates use the same repair.
Doctor repairs cron and session
references through their existing state owners, then backs up and publishes the
config last. The Cloud provider is already available through the Ollama plugin.
If interrupted before config publication, the hosted `ollama` entry remains and
the next Doctor run finishes the idempotent repair. Once config publication
completes, new local Ollama selections are left alone; Doctor never replays old
config backups to infer a provider rename.

## Claude CLI model routing

Claude CLI sign-in now writes `agents.defaults.models["anthropic/*"]` with the
`claude-cli` runtime. Configs from earlier sign-ins pinned only the Claude models
that sign-in added, so other Claude models fell back to the API route and failed
without an Anthropic credential. The Anthropic plugin's Doctor repair adds the
wildcard when the default model is an Anthropic model whose entry pins
`claude-cli`, no `anthropic/*` entry exists, no provider-level Anthropic runtime
is set, and no Anthropic credential is configured (auth profile, provider API
key, `ANTHROPIC_API_KEY`, or `ANTHROPIC_OAUTH_TOKEN`). An API default model with
a Claude CLI fallback is left unchanged, and an existing `anthropic/*` entry is
never replaced. Updates run the same repair through the backed-up Doctor config
write; `openclaw doctor` without `--fix` reports it.

## Command-owner target kinds

Doctor preserves `commands.ownerAllowFrom` target kinds declared by channel plugins.
For example, `discord:user:123456789012345678` stays a direct-user target;
rewriting it to `discord:123456789012345678` would leave heartbeat delivery unable
to prove a direct route. Command authorization still compares the channel's native
sender identity.

For an active owner-targeted heartbeat, Doctor checks ambiguous owners against the
existing `.bak` through `.bak.4` config history. It restores a recorded `user:` kind
only while the entire owner list still matches the old migration's output. It
does not search past changed owners, unreadable history, or historical includes.
Without that evidence, Doctor leaves the entry unchanged and reports the exact
replacement to use after confirming the ID belongs to the intended user. This
warning does not block updates. Repairs use Doctor's normal config backup and
write path, so update rollback can restore the previous config.

## Retention policy

OpenClaw supports migrations from formats written by shipped releases on or after
July 1, 2026. The publication date controls this cutoff: an older version number
published later, including an extended-stable release, still counts. Retain a
transform whenever a release in that window can still write its input format.
A supported release that preserves a legacy
format when rewriting existing data also counts as a writer. A format last
written before the cutoff may be retired together with its Doctor checks.
When Doctor refuses a retired input, it names an intermediate release to upgrade
through before retrying. Retirement must leave persisted source data untouched.

Except for the deferred readers recorded below, legacy normalization belongs to
Doctor and migration owners, with the existing backup and verification flow.
Runtime readers consume canonical state.

### Deferred compaction checkpoints

Keep the runtime readers for session-entry `compactionCheckpoints`, including
their transcript retention references and historical token metrics. Replacing
these supported readers with a durable migration would add more than 300 net
production lines; retain the readers until the format leaves the support window.

The last verified creating release is `v2026.9.3`. Preservation also counts as
writing: `v2026.9.7` retains existing checkpoints during transcript rewind and
branch operations. The scheduled retirement date is **January 1, 2027**, subject
to verifying that no later shipped release writes or preserves the format.
At that point, delete the readers directly instead of adding a temporary Doctor
migration. Keep this record current if another preservation writer ships.

Retained transcript nodes with empty entry metadata remain supported runtime
state; this deferral does not require a Doctor rewrite of those nodes.

### Workspace setup

The nested `<workspace>/.openclaw/workspace-state.json` layout is retired. Its
last stable writer was `2026.6.8`, published to npm on June 16, 2026. Later
preservation rewrites wrote `<workspace>/openclaw-workspace-state.json` instead.
Upgrade through `2026.9.7` and run `openclaw doctor --fix` before updating to
import the nested file. Current Doctor leaves it untouched.
The root-level setup file and workspace attestations remain supported migration
inputs because July releases still wrote them.

### Session settings

Global and project `settings.json` readers refuse retired settings before
discovering agent resources. They preserve the original file and name the fields
to repair. Back up the file, keep any existing canonical values, and replace:

- `queueMode` with `steeringMode`.
- `websockets` with `transport`: `true` becomes `"websocket"`, and `false` becomes `"sse"`.
- An object-shaped `skills` with its `customDirectories` array, or `[]` when absent.
  Move `skills.enableSkillCommands` to top-level `enableSkillCommands` if present.
- `retry.maxDelayMs` with `retry.provider.maxRetryDelayMs`, preserving the other
  `retry.provider` settings.

Remove superseded keys after moving their values. OpenClaw `2026.9.7`
retains the former settings reader if a staged upgrade is needed; see
[upgrading very old versions](/install/updating#upgrading-very-old-versions) before
using an older release with existing state. These embedded session files are
separate from `openclaw.json`: current `doctor --fix` owns supported July-and-later
config migrations, but does not rewrite these retired session settings.

The `keybindings.json` reader also refuses retired action names such as `interrupt`
and `submit`, naming their replacements (`app.interrupt` and `tui.input.submit`).
Back up the file and rename the reported entries, keeping existing canonical
bindings when both names occur. A refused reload preserves the last accepted
bindings and leaves the file untouched. Unknown custom action names remain
supported. OpenClaw `2026.9.7` retains the former keybinding reader; current Doctor
does not rewrite retired keybinding names.

### Retired state and config formats

Unreleased per-agent SQLite session layouts below schema 8 and their pre-landing
transcript search caches are retired. Doctor refuses those layouts without
repairing their tables. Shipped schema-1
memory/auth/cache databases remain supported; see [agent schema
history](/reference/database-schemas/agent-schema-history) for the supported
layouts and recovery route.

Telegram's pre-July bot-info, sticker, thread-binding, update-offset, message,
sent-message, and topic-name JSON sidecars are no longer inspected or archived.
Their last file writers shipped in May 2026. To recover state held only in those
files, use a pre-update backup with OpenClaw `2026.9.5` Doctor before updating.
See [legacy state migration](/cli/doctor/state-migrations).

Telegram SQLite update-offset versions 1 and 2 remain supported because published
July-era Doctor imports can still write them. Doctor normalizes those rows to
version 3 after saving a verified SQLite backup. The cursor, row timestamps,
expiry, and unrelated fields are preserved. Missing bot identity and token
fingerprints remain null; account startup retains responsibility for token
rotation and any required ingress purge. Updates run this repair before account
startup. After a manual package replacement, run `openclaw doctor --fix` first.

Old `openclaw.extension.json` npm declaration stubs are ignored by discovery and
Doctor. They are not plugin manifests, and their files remain unchanged. Reinstall
the package with `openclaw plugins install npm:<package>` and update any explicit
`plugins.load.paths` entry to the installed plugin root. To use the old automatic
stub repair, run `openclaw doctor --fix` on `2026.9.7` before upgrading. Current
`openclaw.plugin.json` manifests and npm package installation remain supported.

Discord `voice.tts.<provider>` blocks and guild-channel `allow` and `agentId`
settings are also retired, including account overrides. Doctor preserves the
original config and names the affected path. Install `2026.9.7`, run
`openclaw doctor --fix`, then upgrade again. The repaired forms are
`voice.tts.providers.<provider>`, guild-channel `enabled`, and top-level `bindings`.

Device Pair `device-pair-notify.json` is retired. Upgrade through `2026.9.5` and
run `openclaw doctor --fix` to import subscribers. Verify the imported state
before updating. If the intermediate release retains the original file for
rollback or cannot interpret an empty or invalid source, preserve a backup and
move that file out of the active state directory before retrying. Current Doctor
refuses the retired source without deleting or rewriting it.

Discord model preferences and thread bindings stored in JSON, plus iMessage
reply-cache, sent-echo, and catchup files, are also retired. Upgrade through
`2026.9.5`, run `openclaw doctor --fix`, and verify the imported SQLite state.
Preserve a backup and move any retained original files out of the active state
directory before updating; current Doctor refuses these sources without
modifying their bytes. Discord's July-era command deployment cache migration
remains supported and rebuilds its disposable hashes.

Voice Call JSONL call logs are retired pre-July state. Upgrade through
`2026.9.7` and run `openclaw doctor --fix` to import them before updating.
Current Doctor preserves remaining JSONL sources and reports that intermediate
upgrade. SQLite schema repair remains supported.

Voice Call config migration remains supported for `provider: "log"`,
`twilio.from`, flat streaming provider settings, and
`realtime.agentContext.includeSystemPrompt`. Published `2026.9.7` can preserve
and rewrite these settings while plugin repair is deferred. Doctor owns their
normalization, preserves canonical values, and backs up config before writing;
runtime parsing accepts only the canonical shape.

OpenClaw `v2026.9.7` can still write ownerless and mode-less cron jobs, and its
migration/import writers can preserve null, `deliver`, or mixed-case delivery
modes. Those cron repairs remain supported. JSON quarantine files also remain supported:
`v2026.7.35` still writes them.

Cron JSON job stores (`jobs.json`), split runtime state (`jobs-state.json`), and
per-job `runs/*.jsonl` history were last written by stable `v2026.5.28`; the
May 30 SQLite cutover removed those writers. Doctor refuses these files before
repairing cron or changing config, preserving their original bytes and any
supported quarantine sidecar. Install `2026.9.7`, run `openclaw doctor --fix`, then
upgrade to the latest version. Candidate update admission checks the original
live files and reports the upgrade requirement before activation, including when
a published updater omits those files from its later rehearsal snapshot. Existing SQLite cron stores,
including their owner and delivery repairs, keep their normal update path.

Doctor refuses pre-July JSON delivery queue files and leaves them unchanged.
Upgrade through `2026.9.7` and run its `openclaw doctor --fix` before retrying.
Current SQLite queues remain supported. Updates driven by `2026.9.7` check these
original files before stopping the running Gateway. The same early check reports
the existing recovery guidance for a retired `plugins/installs.json` index. See
[state migration recovery](/gateway/doctor/state-and-sessions).

Voice Wake trigger/routing JSON, plugin-binding approvals,
current-conversation bindings, ACP replay `acp/event-ledger.json`, and
`restart-sentinel.json` are retired. Their last writers shipped before July 1.
A leftover `update-check.json` is only a notification cache, so Doctor and
updates ignore it.
Doctor and update admission preserve the files and refuse with the intermediate
upgrade path: install `2026.9.7`, run `openclaw doctor --fix` on the original
host, then retry. Interrupted ACP and restart-sentinel import claims are also
preserved. Current SQLite state and the supported config-health importer remain
unchanged. Plugin-binding approvals retain their original default-home scope;
a custom state directory does not inspect another profile's approval file.

Startup leaves these retired files for Doctor. When `openclaw gateway run` or
a local `openclaw message send` prepares that state, it continues without
importing the files, logs a warning, and retains that deferred outcome in the
startup diagnostics. Their presence alone does not prevent bootstrap or a
recovery restart. Gateway-routed message clients leave state preparation to the
running Gateway.
If this advisory inspection fails, startup records the error with guidance to
run `openclaw doctor` and continues without changing the files.

Doctor also refuses these retired config inputs:

- `agents.defaults.llm`, agent `embeddedPi`, `embeddedHarness`, whole-agent
  `agentRuntime`, `systemPromptOverride`, and `sandbox.perSession`.
- Agent and surface `silentReplyRewrite` and `silentReply.direct`.
- Agent `model.timeoutMs` and `subagents.model.timeoutMs`, including defaults.
  Timeouts on tool-model selectors remain supported.
- `memorySearch.store.path`, including its agent and `memory.search` forms.
- `plugins.installs`, `gateway.webchat`, `session.parentForkMaxTokens`,
  `browser.relayBindHost`, and `browser.ssrfPolicy.allowPrivateNetwork`.
- Extension browser profiles with a legacy `cdpUrl`. Current extension profiles
  discover their relay endpoint automatically; the extension driver remains supported.
- The `openai-codex-responses` provider or model API identifier. The intermediate
  release migrates it to `openai-chatgpt-responses` before the current provider repair.
- Queue modes `queue`, `steer-backlog`, and `steer+backlog` in `messages.queue.mode`
  or `messages.queue.byChannel`.
- Top-level `heartbeat`, `routing.allowFrom`, and `routing.groupChat`.
- Top-level Talk realtime selectors `talk.mode`, `talk.transport`, `talk.brain`,
  `talk.model`, and `talk.voice`.
- `channels.telegram.requireMention`, `channels.feishu.accounts.<id>.botName`,
  and the retired `channels.webchat` section.
- `channels.telegram.groupMentionsOnly`; use `channels.telegram.groups["*"].requireMention`.
- `channels.whatsapp.exposeErrorText`, including account overrides.
- `session.threadBindings.ttlHours` and Discord/LINE/Matrix/Telegram `threadBindings.ttlHours`,
  including per-account settings.
- Telegram `dm`, `direct.*.threadReplies`, native draft preview settings, and scalar
  or flat streaming settings (`streamMode`, `chunkMode`, `blockStreaming`,
  `blockStreamingCoalesce`, and `draftChunk`), including account overrides.
- Nextcloud Talk `allowPrivateNetwork`; use the intermediate migration before the
  canonical `network.dangerouslyAllowPrivateNetwork` setting.
- Matrix `dm.policy: "trusted"`, flat `allowPrivateNetwork`, and `allow` in
  `groups.<room>` or `rooms.<room>`, including account overrides.
- Slack `channels.<id>.allow`, including account overrides.

Configs containing these keys must be repaired before current validation can
succeed. Doctor preserves the config and stops with recovery guidance instead
of stripping these settings or replacing them with a backup. For an older installation,
[upgrade through `2026.9.5`](/install/updating#upgrading-very-old-versions)
and run its Doctor migrations before installing the latest version.

WhatsApp's `exposeErrorText` has been ignored since April 2026. Remove it from
the reported channel or account path before retrying; removing this no-op does
not change error delivery. Doctor leaves the authored config unchanged, or you
can use the intermediate release above to remove it.

OAuth credential sidecars under `credentials/auth-profiles/` are retired. Their
last writer shipped in `2026.5.16-beta.3` on May 16, 2026; `2026.5.16-beta.4`
removed that writer. Doctor detects these files without reading credentials or
accessing encryption keys. When a legacy `auth-profiles.json` still references
one, upgrade through `2026.9.7` and run `openclaw doctor --fix` on the original
host before retrying. Sidecars that no legacy profile references stay in place
and do not block the upgrade; `2026.9.7` also keeps them, because agent
directories outside its scan might still use them. The supported `auth.json`,
`auth-profiles.json`, SQLite credential, and migration-recovery contracts
remain unchanged.

## Cron ownership before roster migration

Before retiring a legacy agent roster's default marker, Doctor pins ownerless
cron jobs to that historical agent. This also applies when a different system
agent is selected. Explicit job owners and agent-qualified session keys remain
unchanged. Doctor saves a verified SQLite backup and rechecks the stored owner
and definition before committing. If ownership cannot be repaired, it preserves
the roster marker and reports the condition to resolve.

When delivery normalization precedes ownership repair, each stage saves its own
verified snapshot. The earliest backup preserves the original persisted cron
definitions, ownership, and runtime state. Archived supported quarantine JSON
keeps its original bytes.

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
During the earlier update rehearsal, Doctor can import quarantine rows and
normalize cron definitions in the private database copy. It preserves uncopied
quarantine files, including linked files, and reports their deferred archival.
The live Doctor phase imports those sources and archives them after package
installation. This also protects updates started by supported older releases.

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

## Exec approval policy

Doctor normalizes legacy exec approval policy already stored in SQLite as well
as imported JSON files. Before rewriting a SQLite row, it preserves a verified,
private database snapshot named `openclaw.sqlite.pre-exec-approvals-migration-*.bak`.
It moves the historical `default` agent policy into `main`, retaining explicit
`main` values and merging allowlist entries and MCP grants. String allowlist
entries become objects with stable IDs. Obsolete `commandText` and unrecognized
source labels remain in the backup; current command-use metadata, socket
credentials, and the row's update timestamp are preserved.

Runtime readers require canonical policy and report `openclaw doctor --fix`
guidance for a legacy row without replacing it. The update-time Doctor pass
runs the same migration. Repeating Doctor leaves the normalized row and its IDs
unchanged. Published SDK and operator input normalization remain available at
the input boundary.

## Claw provenance schema

Claw update plans and resume previews require the current provenance columns.
Older SQLite databases that lack bootstrap or extension provenance columns now
stop with `openclaw doctor --fix` guidance. Read-only planning leaves those
databases unchanged instead of projecting absent columns as empty values.

Doctor and the update-time Doctor pass use the existing shared-state schema
repair. Doctor preserves a verified pre-migration database snapshot even when
the numeric schema version is already current, then adds the missing nullable
columns. Install records, package references, timestamps, and consent-bound v1
resume plans retain their values. Repeating the repair is idempotent.

## Channel account routing during an update

Doctor preserves existing channel account maps and their implicit default route.
Shared root policy never creates an extra `accounts.default` beside named accounts.
An empty account map can still receive migrated single-account fields; plugins
such as WhatsApp keep their supported shared policy at the root.

When a policy-only, unlinked WhatsApp `accounts.default` sits beside named
accounts, Doctor warns that it may be left over from an earlier promotion or may
be an intentional account awaiting login. It names the account currently selected
for unqualified operations and leaves the account map, shared policy, and routing
unchanged. Doctor cannot infer who created an account from this config shape.

To explicitly select an existing named account while retaining all accounts and
shared policy, run `openclaw config set channels.whatsapp.defaultAccount '"work"' --strict-json`
(replace `work` with the desired account ID). If you decide the default account is
unwanted, first preserve any shared policy inherited from it, then run
`openclaw channels remove --channel whatsapp --account default --delete`.
Doctor's warning provides the command for a configured named account. It does not
perform either action, including during updates or repeated `doctor --fix` runs.

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

## Agent roster migration

Ordinary config reads require canonical keyed `agents.entries`; they do not
convert a populated `agents.list` or remove legacy `default` markers. Run
`openclaw doctor --fix` before starting a directly replaced binary with those
inputs. The normal `openclaw update` flow invokes the candidate Doctor. Fresh
configs without a roster still receive the in-memory `main` default.

Doctor retains the original roster order and historical owner while migrating
config and persisted state, including ownerless cron jobs. It preserves the
legacy workspace and materializes the required per-surface owners before
retiring the marker. Explicit system-agent, auth-inheritance, and other role
owners remain independent: choosing a different system agent does not change
which agent owns existing legacy data. Keep the original markers until Doctor
has completed both the config and state repairs.

Doctor follows the existing [include write constraints](/gateway/config-secrets-env).
A root-level `$include`, or a repair spanning an included roster and root-owned
roles, can require manual preparation; repeating `doctor --fix` alone does not
remove that ownership constraint. Preserve backups of the root config, included
files, and persisted state. Temporarily consolidate the original include-resolved
legacy config into one `openclaw.json`, retaining list order, default markers,
authored environment and secret references, and the meaning of configured paths.
Do not substitute an already normalized runtime view or remove the legacy marker
by hand: Doctor still needs that provenance to migrate data ownership.

Run `openclaw doctor --fix` or retry the update with that single-file config.
After repair completes and `openclaw config validate` succeeds, split the
canonical config back into includes if desired, then validate it again. Keep
the backups until the repaired config and migrated state have been verified.

## Channel private-network opt-ins

Matrix, Mattermost, and Tlon runtime paths read only
`network.dangerouslyAllowPrivateNetwork` at the channel or account scope.
Tlon retains its plugin-owned Doctor transform for the older flat
`allowPrivateNetwork` key. It preserves an explicit canonical boolean, including
`false`. Run `openclaw doctor --fix` before using that legacy config with a
directly replaced binary. Updates invoke the same transform through Doctor and
the normal config backup flow. Deferred plugin migrations retain their inputs
for Doctor after installation; those inputs do not enable runtime private-network
access.

The Matrix and Mattermost flat-key migrations are retired. Repair their old
config with `openclaw doctor --fix` on `2026.9.7` before upgrading.

## Channel webhook listeners

Feishu, Microsoft Teams, Nextcloud Talk, and Telegram receive webhooks on Gateway
HTTP routes. New installations open no separate webhook port unless
`legacyWebhook: { port, host? }` explicitly selects one.

Doctor preserves existing callbacks with a one-shot migration. It checks evidence
of prior Gateway operation, channel ingress, or an update, rather than comparing
version strings or treating an empty state database as an existing installation.
For an enabled webhook account with no explicit or inherited `legacyWebhook`
setting, it pins the historical endpoint: Feishu `127.0.0.1:3000`, Teams wildcard
port `3978`, Nextcloud Talk `0.0.0.0:8788`, or Telegram `127.0.0.1:8787` when its
callback URL does not match its configured public Gateway destination or its
configured path cannot be served by the Gateway. Disabled accounts, Telegram polling, and
Feishu WebSocket transport receive no pin. Explicit objects and `false` settings
remain authoritative.

Explicit and update-time Doctor use the same migration owner. Doctor validates
and backs up the config through the normal write flow. Pins and the
`meta.migrations.webhookListeners` completion marker are saved together, including
when channel settings come from `$include` files. Fresh installations record
`true` without pins. Existing installations record an object whose keys are
completed channel IDs and whose values list the exact config paths inserted by
the migration; an empty list means the channel needed no pin.

Keep this marker when removing a pin. Subsequent Doctor runs, restarts, and
updates will not recreate it. Account pins cover only accounts present during
migration. For trusted official plugins with older Doctor contracts, Doctor uses
historical listener facts shipped with the Gateway. The installed plugin retains
ownership of its other config migrations. During an update, these listener repairs
also run when an installed official plugin is deferred until package convergence;
its deferred code is not loaded, and replacement plugins retain their ownership.
Other plugins can remain pending while
other channels finish. Replacing a pending plugin runs the same migration through
the installer's backed-up config publication before its new runtime starts.
Update a retained older standalone plugin before removing its pin; older plugin
versions can still open their historical default port.

Startup leaves config bytes unchanged. When the completion marker is the sole
required change, startup records it in canonical SQLite machine state, including
when no config file exists yet. If endpoints or other channel settings need
repair, startup refuses with `openclaw doctor --fix` guidance. For a read-only
external config source, update that source and its completion marker as directed
by the startup error. Startup refuses to drop an unmigrated endpoint. A fresh
installation needs no pins or a new config file that would interfere with
`gateway --dev` setup.

The existing explicit-key migrations remain supported: `webhookPort` and
`webhookHost` become `legacyWebhook: { port, host? }`; Teams `webhook.port` becomes
`legacyWebhook.port` while `webhook.path` is preserved. A host-only setting keeps
its historical default port. Both listeners use the same Gateway request pipeline,
signature checks, and retry responses.

The exported Feishu, Microsoft Teams, Nextcloud Talk, and Telegram config types
retain deprecated listener input properties (`webhookPort`, `webhookHost`, or
`webhook.port`) until the next Plugin SDK major. TypeScript config producers remain
source-compatible, but parsed runtime config uses only `legacyWebhook`; run Doctor
before using legacy inputs.

Update the external callback or reverse-proxy upstream to the Gateway port and
the channel's webhook path, verify delivery, then remove the pin to close the old
port. Use account-level `legacyWebhook: false` to disable an inherited endpoint.
A shared compatibility port closes when no account retains it. Doctor identifies
the Gateway route and the external callback or proxy change still required.

New separately installed Feishu, Microsoft Teams, Nextcloud Talk, and Telegram
plugins require OpenClaw 2026.9.9 or newer so the host can preserve implicit listeners before
replacement. Older hosts refuse these packages and retain the installed plugin;
upgrade OpenClaw first.

For Telegram with no explicit listener setting, Doctor recognizes a Gateway
destination when `webhookUrl` matches `gateway.publicOrigin` plus a usable
`webhookPath`, including the path and query. Startup registers the configured
`webhookUrl` unchanged. Registration must succeed before channel
readiness releases an old listener handoff; admitting an incoming webhook does
not release it. A full process restart still has its ordinary restart interval.
Any other callback URL may still proxy to the old port, so Doctor preserves that
port with a pin even when `gateway.publicOrigin` is configured. Set `webhookUrl`
to the public Gateway route before removing the pin, or move the existing proxy's
upstream to the Gateway port. Explicit endpoint objects and `false` remain authoritative.
Accounts that shared a path and secret on different ports must use distinct
secrets or paths before moving them to one Gateway port.

Microsoft Teams keeps its Express body parser, ExpressAdapter, and SDK
authentication on both listeners. Move its Azure Bot messaging endpoint or proxy
upstream to the Gateway route before removing the pin.

For environment-only Teams credentials, Doctor preserves the endpoint without
persisting activation; `gateway run --ambient-channels` still controls whether
Teams runs. If Doctor runs without those credentials, an existing installation
leaves only the Teams migration pending until the first Gateway startup; other
channels remain completed. A startup without Teams credentials, or a newly authored
Teams configuration, completes that decision without a pin. Adding Teams later
does not reopen its old port. Existing listener-only source configurations gain
`enabled: true` to preserve their previous activation.

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

## ACP session metadata

Doctor moves historical raw, agent-prefixed, and ownerless ACP metadata keys to
canonical keys bound to the owning session. It also imports ACP metadata embedded
in SQLite session entries. Before rewriting a source database, Doctor saves a
verified private SQLite backup and reports its path. Rekeying preserves every
metadata column except the key. Embedded imports keep the canonical ACP fields,
including identity and runtime-options JSON, lifecycle binding, and last activity;
the entry's update timestamp becomes the metadata update timestamp. Unknown
embedded fields remain in the source backup. Embedded JSON follows the session
decoder's last-value semantics for duplicate properties. Ambiguous ownership and conflicting
payloads remain intact with a warning naming the affected session.

Runtime reads and writes use canonical metadata only. Startup refuses unmigrated
ACP state with a current session binding before handing session stores to
runtime, with offline repair instructions. Historical shared rows whose binding
is absent or stale remain intact and do not block startup; runtime does not serve
their metadata. Unreadable candidate stores and unresolved recorded owners still
block admission. Run `openclaw doctor --fix` after restoring older state; the update-time
Doctor pass runs the same repair.
Embedded metadata imports record durable receipts before removing the source
field, so retrying interrupted cleanup cannot reopen a session after its canonical
metadata was cleared. Legacy `sessions.json` imports retain their existing backups
and source receipts.

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

Doctor settles an unavailable plugin's old obligation when its protected config
is empty or absent and it carries no outstanding state-migration or inspection
requirement. The existing migration receipt records that there was nothing to
migrate. A known official replacement can supersede the old obligation after
its migration completes and no old plugin settings remain to transfer. Stored
plugin data is kept; these outcomes do not enable plugins or widen allowlists.
Legacy fields excluded from validation remain protected even when their value is
an empty object or array; their owner must interpret or remove them.
An explicitly enabled plugin that passes activation policy keeps its package
obligation until it becomes available, even when it has no custom settings.
Update rehearsals leave unavailable-owner settlement to live update finalization.

If retained settings or an explicit state/inspection requirement remain, Doctor
keeps the obligation pending and names the plugin to install or enable. A retired
plugin may need its maintainer's supported recovery path. Disabling or uninstalling
the plugin does not by itself complete its migration. Update status and startup
read the same settled receipts after Doctor finishes; an updating parent that
still owns plugin installation continues to defer the work.

While a migration is pending, explicit config edits that would change or remove
its retained inputs are refused with the recovery command. Unrelated settings
remain writable. Complete the plugin migration before editing those inputs.

## Blocked local plugins

Doctor preserves the complete configuration entry and plugin policy for a local
plugin rejected by discovery, including ownership and writable-path safety
checks. A blocked plugin is not an uninstalled plugin. Its runtime remains
blocked, and Doctor reports the path problem instead of removing its enablement
or suggesting a registry reinstall for a local path. Fix the path and rerun
`openclaw doctor --fix` as the account that runs the Gateway.

This preservation also applies when an update invokes the candidate Doctor. It
does not change the update execution account or repair files already made owned
by another user.

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

Terminal deliveries marked `failed` remain historical and are not automatically
restarted. Doctor also settles a pending delivery as `failed` when its task has
finished (`succeeded`, `failed`, or `cancelled`) and its original requester binding
is missing, cleared, or no longer matches the recorded session, lifecycle, or
connection. It appends an `Undeliverable historical delivery` reason to the task's
existing `error` field and preserves any previous error, execution status, result,
native locator, and ownership facts. This does not claim successful delivery or
import the result into a replacement parent. The row remains available for
inspection, and subsequent migration passes leave it historical. If no other
Codex migration is pending, the normal plugin lifecycle confirms data readiness
and resumes full settings validation.

The migration writes `nativeSubagentAssignments` and the per-source Task ID
marker `nativeSubagentTaskImport` together in one compare-and-apply operation on
the existing `app-server-thread-bindings` plugin state. A changed binding is
preserved and reported for retry. Acknowledgement can consume the assignment,
while the import marker survives acknowledgement, native rotation, clear, and
reset so unchanged legacy rows cannot resurrect completed work. The shared
database is declared in the migration's backup inventory, so the pre-migration
backup also restores delivery settlement on rollback. Imported source Task rows
remain byte-identical; historical settlement changes only delivery status and
the recorded error. There is no new SQL table, schema-version bump, Tasks
runtime reader, or replacement Task ledger. Native execution and completion
delivery continue to require current requester authority.

Unstamped records, including 2026.9.2-era rows, cannot establish the missing
physical requester and connection history. Doctor also preserves ambiguous
duplicate run IDs, malformed records, and unfinished work whose ownership no
longer matches. It emits a
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
    GitHub Copilot now requires explicit provider config, a saved Copilot auth profile, or `COPILOT_GITHUB_TOKEN`. Generic `GH_TOKEN` and `GITHUB_TOKEN` no longer activate it. Doctor reports this change once when only a generic GitHub token is present. Doctor removes the retired `plugins.entries.github-copilot.config.discovery.enabled` setting, including malformed values, before validating and saving the config. Ordinary config reads require the repaired config.

    Doctor normalizes legacy value shapes into the current schema. Current Talk speech config is `talk.provider` + `talk.providers.<provider>`, with realtime voice config under `talk.realtime.*`. Doctor rewrites old `talk.voiceId` / `talk.voiceAliases` / `talk.modelId` / `talk.outputFormat` / `talk.apiKey` shapes into the provider map. Top-level realtime selectors are retired under the retention policy above.

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

    For legacy rosters with multiple agents and no resolvable ambient owner, Doctor seeds `agents.defaults.systemAgent.agentId` from a uniquely marked `default: true` agent, or `main` when present. Sole-agent rosters need no owner repair. Doctor converts valid legacy default markers into explicit per-surface owners before runtime admission. Explicit fleet ownership disables the legacy default-marker fallback, so those rosters may still need repair. Doctor also pins `agents.defaults.heartbeat.agentId` only when heartbeat enrollment would otherwise be unresolved; existing heartbeat owners, shared defaults, and per-agent enrollment are preserved. These changes are reported and saved by `doctor --fix`, including the update-time doctor pass. If no default can be identified, configure the system-agent owner explicitly.

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
    | `channels.<id>.voice.tts.<provider>` / `channels.<id>.accounts.<accountId>.voice.tts.<provider>` (all channels except Discord)                          | `...voice.tts.providers.<provider>`                                          |
    | `plugins.entries.voice-call.config.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`)     | `plugins.entries.voice-call.config.tts.providers.<provider>`                |
    | `plugins.entries.voice-call.config.tts.provider: "edge"` / `...tts.providers.edge`                | `provider: "microsoft"` / `...tts.providers.microsoft`                      |
    | `plugins.entries.voice-call.config.provider: "log"`                                              | `"mock"`                                                                      |
    | `plugins.entries.voice-call.config.twilio.from`                                                  | `plugins.entries.voice-call.config.fromNumber`                              |
    | `plugins.entries.voice-call.config.streaming.sttProvider`                                        | `plugins.entries.voice-call.config.streaming.provider`                      |
    | `plugins.entries.voice-call.config.streaming.openaiApiKey`/`sttModel`/`silenceDurationMs`/`vadThreshold` | `plugins.entries.voice-call.config.streaming.providers.openai.*`             |
    | `models.providers.*.api: "openai"`                                                               | `"openai-completions"` (gateway startup also skips providers whose `api` is a future/unknown enum value rather than failing closed) |
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
    | `skills.workshop.autonomous.mode: "propose"`, `skills.workshop.approvalPolicy`, `skills.workshop.maxPending` | `"off"`; proposal settings removed (Skill Workshop proposals were retired) |

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
