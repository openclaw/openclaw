---
summary: "Config normalization, legacy config key migrations, and update-time schema publication"
title: "Config and migration repairs"
read_when:
  - Doctor reports a legacy config key or a failed config migration
  - You are adding or modifying a config migration
---

Checks 0-2 cover config normalization and the legacy config key migrations,
plus how doctor publishes shared-state schema during an update.

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

## Device worker inference naming

For pre-release opt-in `cloudWorkers.profiles` entries whose provider is `device`,
Doctor renames
`settings.inference: "runtime-local"` to `"worker"`. Explicit `"gateway"`, omitted
inference, and other providers' settings stay unchanged. Eligible Gateway startup
uses the same transform and normal config backup/validation safeguards.

This repairs authored configuration only. Existing worker environments keep their
recorded snapshots, including the earlier spelling, and retain worker inference
until reclaimed or retired. Profile edits do not change an existing binding. The
worker launch dialect, database schema, and Gateway/proxied defaults do not change.
See [Worker-local inference](/gateway/cloud-workers/native-inference).

## Channel webhook listeners

Telegram now receives webhooks on Gateway HTTP routes. Its plugin-owned Doctor
migration moves an explicitly configured `webhookPort` and effective bind host
into `legacyWebhook: { port, host? }`. An explicit host without a port keeps that
host with port `8787`. Doctor validates and backs up the config through the normal
write flow. The compatibility listener forwards only its registered webhook
routes through the same Gateway request pipeline, preserving signatures and retry
responses during channel restarts.

The exported Telegram config types retain deprecated `webhookPort` and
`webhookHost` input properties until the next Plugin SDK major. TypeScript config
producers remain source-compatible, but parsed runtime config uses only
`legacyWebhook`; run Doctor before using legacy inputs. This type compatibility
window does not schedule removal of the default listener.

Update the external callback or reverse-proxy upstream to the Gateway port and
the channel's webhook path, verify delivery, then set `legacyWebhook: false` to
close the old port. Omitting `legacyWebhook` preserves Telegram's previous
`127.0.0.1:8787` listener whenever the account uses webhook mode. An explicit
object selects its configured endpoint; an account-level value overrides the
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

    Older Git updaters can keep an in-memory config snapshot and write it after Doctor exits. When that parent marks the update in progress without advertising support for Doctor config writes, Doctor preserves the config and defers importing retired plugin install records, including with `--fix`. A supported fresh update continuation runs Doctor before plugin convergence and rereads the repaired config. Existing canonical plugin install records keep precedence. Doctor imports missing records before rewriting config and completes required workspace-state migration in the same repair pass. An older Git updater without that continuation requires `openclaw doctor --fix` after the update; Gateway startup does not finish its legacy repair.

    Gateway and local CLI startup validate current config without rewriting legacy keys. Invalid legacy config remains unchanged and startup prints the `openclaw doctor --fix` hint. An interactive terminal can offer to run Doctor and retry once; headless services stop with the hint. Doctor preserves the original in the five-slot `openclaw.json.bak` / `.bak.1` through `.bak.4` backup ring before writing a validated repair. Includes, externally managed config, newer-written config, and unresolved validation errors retain their existing repair and recovery safeguards.

    Ordinary config recovery can restore an already valid backup without changing its authored bytes. A backup that needs legacy transformations must be recovered through Doctor, which applies the same shared migration transforms before validation and restoration.

    Doctor checks the authored config revision, included files, and environment-resolved values before migration writes. Runtime path expansion (such as `~/.openclaw/wiki` on Windows) does not count as an input change. A real change reports whether the config path, file contents, included files, or resolved values changed; rerun Doctor so migrations can validate the new inputs.

    When model migrations change a configured consumer between subscription/OAuth and metered API-key billing, Doctor reports the consumer, model, and old and new routes after saving the config. The warning also appears in the diagnostic log and update run record. A later Doctor run does not repeat it when the resolved billing route is unchanged. Missing credentials are not treated as proof of a billing change.

    During an update, Doctor records model-retirement repairs that must wait until plugin installation finishes. The updated OpenClaw completes those repairs after plugin convergence, even when no plugin version changed. `openclaw update status` records their completion so retired subscription models do not fall through to metered API credentials.

    Utility-model separation preserves an older config's implicit primary before recording `meta.migrations.utilityModelSeparation: true`. Doctor and normal config writes use the previous config to save that primary explicitly; existing primary selections, fallbacks, and credential bindings stay authoritative. This keeps regular chat available when the old implicit primary also served utility tasks. Fresh utility setup records the separation without choosing a primary, and a provider added during utility setup is not mistaken for the previous primary. See [agent model configuration](/gateway/config-agents/models#agentsdefaultsmodel).

    Other commands that encounter legacy keys still ask you to run `openclaw doctor`. Doctor explains the issues, shows its migrations, and rewrites `~/.openclaw/openclaw.json` with the updated schema. Cron job store migrations are also handled by `openclaw doctor --fix`; automatic config-key migration does not import legacy session stores or repair services.

    When a readable active config can be fully migrated, Doctor preserves it before considering last-known-good recovery. This includes legacy multi-agent rosters with a `default: true` owner: unrelated settings and the original agent ownership survive the migration.

    Per-agent migrations apply to both keyed `agents.entries` and legacy `agents.list` rosters, including rosters that already set `agents.ownership: "explicit"`. For example, Doctor preserves an agent's legacy `memorySearch` settings under `memory.search`. Existing values at the current config paths take precedence.

    For legacy rosters with multiple agents and no resolvable ambient owner, Doctor seeds `agents.defaults.systemAgent.agentId` from a uniquely marked `default: true` agent, or `main` when present. Sole-agent rosters and legacy default markers already honored by the runtime need no owner repair and produce no missing-owner advice. Explicit fleet ownership disables the legacy default-marker fallback, so those rosters may still need repair. Doctor also pins `agents.defaults.heartbeat.agentId` only when heartbeat enrollment would otherwise be unresolved; existing heartbeat owners, shared defaults, and per-agent enrollment are preserved. These changes are reported and saved by `doctor --fix`, including the update-time doctor pass. If no default can be identified, configure the system-agent owner explicitly.

    <Note>
      Doctor only carries automatic migrations for roughly two months after a
      key is retired. Older legacy keys (for example the original
      `routing.queue`, `routing.bindings`, `routing.agents`/`defaultAgentId`,
      `routing.transcribeAudio`, top-level `agent.*`, or top-level `identity`
      from the pre-multi-agent config shape) no longer have a migration path;
      config using them now fails validation instead of being rewritten. Fix
      those keys by hand against the current
      [configuration reference](/gateway/configuration-reference) before doctor
      can proceed.
    </Note>

    Doctor no longer repairs these pre-June keys:

    - Agent `embeddedHarness`, `embeddedPi`, `sandbox.perSession`, and `agents.defaults.llm`.
    - Top-level `heartbeat`, `routing.allowFrom`, and `routing.groupChat`.
    - `channels.telegram.requireMention`, `channels.feishu.accounts.<id>.botName`,
      and retired `channels.webchat` / `gateway.webchat` sections.
    - `session.threadBindings.ttlHours` and Discord/LINE/Matrix/Telegram `threadBindings.ttlHours`,
      including per-account settings.

    Configs containing these keys must be repaired before current validation can
    succeed. Doctor preserves the config and stops with recovery guidance instead
    of stripping these settings or replacing them with a backup. For an older installation,
    [upgrade through `2026.9.5`](/install/updating#upgrading-very-old-versions)
    and run its Doctor migrations before installing the latest version.

    Active migrations:

    | Legacy key                                                                                    | Current key                                                                 |
    | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
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
    | `browser.ssrfPolicy.allowPrivateNetwork`                                                         | `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`                          |
    | `browser.profiles.*.driver: "extension"` with a stale `cdpUrl`                                  | driver preserved; stale relay URL removed                                     |
    | `browser.relayBindHost`                                                                          | removed (legacy Chrome extension relay setting)                             |
    | `mcp.servers.*.type` (CLI-native aliases)                                                        | `mcp.servers.*.transport`                                                    |
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
    | `agents.defaults/list[].silentReplyRewrite`, `surfaces.*.silentReplyRewrite`                     | removed (exact `NO_REPLY` is no longer rewritten to visible fallback text)  |
    | `agents.defaults/list[].systemPromptOverride`                                                    | removed (OpenClaw owns the generated system prompt)                        |
    | top-level `memorySearch`, `agents.defaults.memorySearch`                                         | `memory.search`                                                             |
    | `agents.entries.*.memorySearch`                                                                     | `agents.entries.*.memory.search`                                               |
    | `memorySearch.provider: "auto"`                                                                  | `"openai"`                                                                    |
    | `memorySearch.store.path` (any level)                                                            | removed (memory indexes live in each agent database)                       |
    | `plugins.openai-codex` policy ids                                                                | `plugins.openai`                                                             |
    | `tools.web.x_search.apiKey`                                                                      | `plugins.entries.xai.config.webSearch.apiKey`                               |
    | `session.maintenance.rotateBytes`, `session.parentForkMaxTokens`                                 | removed (deprecated)                                                        |
    | Runtime and channel tuning knobs retired in 2026.7                                               | removed (built-in production defaults apply)                               |
    | `diagnostics.memoryPressureSnapshot`, legacy `diagnostics.memoryPressureBundle`                  | removed (automatic critical-memory snapshots were retired; no replacement automatic capture) |

    Code Mode's runtime migration preserves an explicit QuickJS choice in global config, keyed agent entries, and legacy agent rosters. Existing `executor` values win, and activation and limits remain unchanged. Selecting the bundled QuickJS runtime works even when generic plugins are disabled or allowlisted, without enabling other plugins; an explicit deny or disabled entry for `code-mode-quickjs` still blocks it. Configurations that never selected a runtime use the new `node` default. See [Code Mode executors](/tools/code-mode/executors) before enabling Node execution; `node:vm` is not a security boundary.

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
