---
summary: "Configuration overview: common tasks, quick setup, and links to the full reference"
read_when:
  - Setting up OpenClaw for the first time
  - Looking for common configuration patterns
  - Navigating to specific config sections
title: "Configuration"
---

OpenClaw reads an optional <Tooltip tip="JSON5 supports comments and trailing commas">**JSON5**</Tooltip> config from `~/.openclaw/openclaw.json`. If the file is missing, OpenClaw uses safe defaults.

The active config path must be a regular file. OpenClaw-owned writes replace it atomically (rename onto the path), so a symlinked `openclaw.json` gets its target replaced rather than written through - avoid symlinked config layouts. If you keep config outside the default state directory, point `OPENCLAW_CONFIG_PATH` directly at the real file.

Common reasons to add a config:

- Connect channels and control who can message the bot
- Set models, tools, sandboxing, or automation (cron, hooks)
- Tune sessions, media, networking, or UI

See the [full reference](/gateway/configuration-reference) for every available field.

Configuration follows a two-bucket rule: root siblings hold infrastructure and cross-agent defaults, while `agents.defaults` holds agent-loop behavior. Entries under `agents.entries` may override either bucket where the schema supports a per-agent override.

Agents and automation should use `config.schema.lookup` for exact field-level
docs before editing config. Use this page for task-oriented guidance and
[Configuration reference](/gateway/configuration-reference) for the broader
field map and defaults.

<Tip>
**New to configuration?** Start with `openclaw onboard` for interactive setup, or check out the [Configuration Examples](/gateway/configuration-examples) guide for complete copy-paste configs.
</Tip>

## Minimal config

```json5
// ~/.openclaw/openclaw.json
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

## Editing config

<Tabs>
  <Tab title="Interactive wizard">
    ```bash
    openclaw onboard       # full onboarding flow
    openclaw configure     # config wizard
    ```
  </Tab>
  <Tab title="CLI (one-liners)">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset plugins.entries.brave.config.webSearch.apiKey
    ```
  </Tab>
  <Tab title="Control UI">
    Open [http://127.0.0.1:18789](http://127.0.0.1:18789) and use the **Config** tab.
    The Control UI renders a form from the live config schema, including field
    `title` / `description` docs metadata plus plugin and channel schemas when
    available, with a **Raw JSON** editor as an escape hatch. For drill-down
    UIs and other tooling, the gateway also exposes `config.schema.lookup` to
    fetch one path-scoped schema node plus immediate child summaries.
    Settings show common fields first. Each section keeps its advanced fields
    in a collapsed **Advanced (N)** group; use **Show advanced** to expand all
    groups. Settings search always includes both tiers and opens the matching
    advanced group when needed. Per-channel settings under **Settings ->
    Channels** use the same split and share the **Show advanced** preference,
    with **Hide advanced** on the divider to collapse them again.
  </Tab>
  <Tab title="Direct edit">
    Edit `~/.openclaw/openclaw.json` directly. The Gateway watches the file and applies changes automatically (see [hot reload](/gateway/configuration/hot-reload)).
  </Tab>
</Tabs>

## Strict validation

<Warning>
OpenClaw only accepts configurations that fully match the schema. Gateway startup first applies safe legacy-key migrations to eligible single-file configs. Unknown keys, malformed types, or invalid values that remain cause the Gateway to **refuse to start**. The only root-level exception is `$schema` (string), so editors can attach JSON Schema metadata.
</Warning>

`openclaw config schema` prints the canonical JSON Schema used by Control UI
and validation. `config.schema.lookup` fetches a single path-scoped node plus
child summaries for drill-down tooling. Field `title`/`description` docs metadata
carries through nested objects, wildcard (`*`), array-item (`[]`), and `anyOf`/
`oneOf`/`allOf` branches. Runtime plugin and channel schemas merge in when the
manifest registry is loaded.

Every config leaf has a common or advanced presentation tier in `uiHints`.
`advanced: false` marks common settings and `advanced: true` marks advanced
settings. A leaf inherits the nearest ancestor tier when it has no direct hint;
paths with no declared ancestor default to advanced. This affects presentation
only, not validation, defaults, reload behavior, or whether the key can be set.

Startup migration uses the same deterministic, prompt-free transforms as `openclaw doctor --fix` and writes only when the entire migrated config validates, including plugins. The previous config stays in the `.bak` ring. Configs using `$include`, Nix-managed configs, and configs written by a newer OpenClaw version are not automatically migrated. See [Legacy config key migrations](/gateway/doctor#detailed-behavior-and-rationale) for the conditions and fallback.

When validation still fails:

- The Gateway does not boot
- Only diagnostic commands work (`openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`)
- Run `openclaw doctor` to see exact issues
- Run `openclaw doctor --fix` (`--repair` is the same flag; `--yes` skips prompts) to apply repairs

The Gateway keeps a trusted last-known-good copy after each successful startup,
but startup and hot reload do not restore it automatically - only `openclaw doctor --fix`
does. If `openclaw.json` remains invalid after eligible startup migrations (including
plugin-local validation), Gateway startup fails. An invalid hot reload is skipped and
the current runtime keeps the last accepted config. When a write is blocked as an
accidental clobber, OpenClaw attempts to save the rejected payload as
`<path>.rejected.<timestamp>` for inspection. The warning reports whether that save
succeeded; if it failed, the active config still stays unchanged.
The Gateway blocks writes that look like accidental clobbers - dropping the effective
`gateway.mode` or shrinking the file by more than half - unless the write explicitly
allows destructive changes. Mode checks resolve `$include` and environment references
first. Missing `meta` is recorded as a write anomaly. Promotion to last-known-good is
skipped when a candidate contains a redacted secret placeholder such as `***` or `[redacted]`.

## Configuration pages

This page is an index. The longer reference sections live on four pages. Open
the page that matches what you need.

| Page                                                                  | Read it when                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Common tasks](/gateway/configuration/common-tasks)                   | You want a copy-paste recipe for a channel, model, access rule, session, or automation. |
| [Config hot reload](/gateway/configuration/hot-reload)                | An edit did not take effect, or you need to know what forces a Gateway restart.         |
| [Config RPC](/gateway/configuration/config-rpc)                       | Tooling writes config over the gateway API instead of editing the file.                 |
| [Environment variables](/gateway/configuration/environment-variables) | You are deciding where an API key lives, or using `${VAR}` substitution or secret refs. |

## Where each section moved

Every anchor this page used to publish is kept here, so an existing link such
as `/gateway/configuration#config-hot-reload` still resolves. Each entry points at
the page that now holds the content.

- <a id="common-tasks" />[Common tasks](/gateway/configuration/common-tasks#common-tasks)
- <a id="set-up-a-channel-whatsapp-telegram-discord-etc" />[Set up a channel (WhatsApp, Telegram, Discord, etc.)](/gateway/configuration/common-tasks#set-up-a-channel-whatsapp-telegram-discord-etc)
- <a id="choose-and-configure-models" />[Choose and configure models](/gateway/configuration/common-tasks#choose-and-configure-models)
- <a id="control-who-can-message-the-bot" />[Control who can message the bot](/gateway/configuration/common-tasks#control-who-can-message-the-bot)
- <a id="set-up-group-chat-mention-gating" />[Set up group chat mention gating](/gateway/configuration/common-tasks#set-up-group-chat-mention-gating)
- <a id="restrict-skills-per-agent" />[Restrict skills per agent](/gateway/configuration/common-tasks#restrict-skills-per-agent)
- <a id="configure-per-channel-health-monitoring" />[Configure per-channel health monitoring](/gateway/configuration/common-tasks#configure-per-channel-health-monitoring)
- <a id="configure-sessions-and-resets" />[Configure sessions and resets](/gateway/configuration/common-tasks#configure-sessions-and-resets)
- <a id="enable-sandboxing" />[Enable sandboxing](/gateway/configuration/common-tasks#enable-sandboxing)
- <a id="enable-relay-backed-push-for-official-ios-builds" />[Enable relay-backed push for official iOS builds](/gateway/configuration/common-tasks#enable-relay-backed-push-for-official-ios-builds)
- <a id="set-up-heartbeat-periodic-check-ins" />[Set up heartbeat (periodic check-ins)](/gateway/configuration/common-tasks#set-up-heartbeat-periodic-check-ins)
- <a id="configure-cron-jobs" />[Configure cron jobs](/gateway/configuration/common-tasks#configure-cron-jobs)
- <a id="set-up-webhooks-hooks" />[Set up webhooks (hooks)](/gateway/configuration/common-tasks#set-up-webhooks-hooks)
- <a id="configure-multi-agent-routing" />[Configure multi-agent routing](/gateway/configuration/common-tasks#configure-multi-agent-routing)
- <a id="split-config-into-multiple-files-include" />[Split config into multiple files ($include)](/gateway/configuration/common-tasks#split-config-into-multiple-files-include)
- <a id="config-hot-reload" />[Config hot reload](/gateway/configuration/hot-reload#config-hot-reload)
- <a id="reload-modes" />[Reload modes](/gateway/configuration/hot-reload#reload-modes)
- <a id="what-hot-applies-vs-what-needs-a-restart" />[What hot-applies vs what needs a restart](/gateway/configuration/hot-reload#what-hot-applies-vs-what-needs-a-restart)
- <a id="reload-planning" />[Reload planning](/gateway/configuration/hot-reload#reload-planning)
- <a id="config-rpc-(programmatic-updates)" /><a id="config-rpc-programmatic-updates" />[Config RPC (programmatic updates)](/gateway/configuration/config-rpc#config-rpc-programmatic-updates)
- <a id="environment-variables" />[Environment variables](/gateway/configuration/environment-variables#environment-variables)
- <a id="shell-env-import-optional" />[Shell env import (optional)](/gateway/configuration/environment-variables#shell-env-import-optional)
- <a id="env-var-substitution-in-config-values" />[Env var substitution in config values](/gateway/configuration/environment-variables#env-var-substitution-in-config-values)
- <a id="secret-refs-env-file-exec-store" />[Secret refs (env, file, exec, store)](/gateway/configuration/environment-variables#secret-refs-env-file-exec-store)

## Full reference

For the complete field-by-field reference, see **[Configuration Reference](/gateway/configuration-reference)**.

---

_Related: [Configuration Examples](/gateway/configuration-examples) · [Configuration Reference](/gateway/configuration-reference) · [Doctor](/gateway/doctor)_

## Related

- [Configuration reference](/gateway/configuration-reference)
- [Configuration examples](/gateway/configuration-examples)
- [Gateway runbook](/gateway)
- [`openclaw config`](/cli/config) — read and write these settings from the CLI
- [`openclaw configure`](/cli/configure) — guided editor for these settings
- [Security audit checks](/gateway/security/audit-checks) — what the audit flags in this configuration
- [Trusted proxy auth](/gateway/trusted-proxy-auth) — configuring the Gateway behind a reverse proxy
