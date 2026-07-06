---
summary: "Configure migrated native Codex plugins for Codex-mode OpenClaw agents"
title: "Native Codex plugins"
read_when:
  - You want Codex-mode OpenClaw agents to use native Codex plugins
  - You are migrating source-installed openai-curated Codex plugins
  - You are troubleshooting codexPlugins, app inventory, destructive actions, or plugin app diagnostics
---

Native Codex plugin support lets a Codex-mode OpenClaw agent use Codex
app-server's own app and plugin capabilities inside the same Codex thread that
handles the OpenClaw turn. Plugin calls stay in the native Codex transcript;
Codex app-server owns app-backed MCP execution. OpenClaw does not translate
Codex plugins into synthetic `codex_plugin_*` OpenClaw dynamic tools.

Use this page after the base [Codex harness](/plugins/codex-harness) is
working.

## Requirements

- The agent runtime must be the native Codex harness.
- `plugins.entries.codex.enabled` is `true`.
- `plugins.entries.codex.config.codexPlugins.enabled` is `true`.
- The target Codex app-server can see the expected marketplace, plugin, and
  app inventory.
- V1 supports only `openai-curated` plugins that migration observed as
  source-installed in the source Codex home.

`codexPlugins` has no effect on OpenClaw-provider runs, ACP conversation
bindings, or other harnesses, because those paths never create Codex
app-server threads with native `apps` config.

OpenAI-side Codex account, app availability, and workspace app/plugin controls
come from the signed-in Codex account. See
[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
for the OpenAI account and admin model.

## Quickstart

Preview migration from the source Codex home:

```bash
openclaw migrate codex --dry-run
```

Add `--verify-plugin-apps` to make migration call source `app/list` and
require every owned app to be present, enabled, and accessible before
planning native activation:

```bash
openclaw migrate codex --dry-run --verify-plugin-apps
```

Apply the migration when the plan looks right:

```bash
openclaw migrate apply codex --yes
```

Migration writes explicit `codexPlugins` entries for eligible plugins and
calls Codex app-server `plugin/install` for selected plugins. A migrated
config looks like this:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          codexPlugins: {
            enabled: true,
            allow_destructive_actions: true,
            plugins: {
              "google-calendar": {
                enabled: true,
                marketplaceName: "openai-curated",
                pluginName: "google-calendar",
              },
            },
          },
        },
      },
    },
  },
}
```

After a `codexPlugins` change, new Codex conversations pick up the updated
app set automatically. Run `/new` or `/reset` to refresh the current
conversation. A gateway restart is not required for plugin enable/disable
changes.

## Manage plugins from chat

`/codex plugins` inspects or changes configured native Codex plugins from the
same chat where you operate the Codex harness:

```text
/codex plugins
/codex plugins list
/codex plugins disable google-calendar
/codex plugins enable google-calendar
```

`/codex plugins` is an alias for `/codex plugins list`. The list shows each
configured plugin's key, on/off state, Codex plugin name, and marketplace
from `plugins.entries.codex.config.codexPlugins.plugins`.

`enable`/`disable` write only to `~/.openclaw/openclaw.json`; they never edit
`~/.codex/config.toml` or install new Codex plugins. Only the owner or a
gateway client with the `operator.admin` scope can run them.

Enabling a configured plugin also turns on the global `codexPlugins.enabled`
switch. If the plugin was written disabled because migration returned
`auth_required`, reauthorize the app in Codex before enabling it in OpenClaw.

## How native plugin setup works

The integration tracks three states:

| State      | Meaning                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Installed  | Codex has the local plugin bundle in the target app-server runtime.                                                              |
| Enabled    | OpenClaw config allows the plugin for Codex harness turns.                                                                       |
| Accessible | Codex app-server confirms the plugin's app entries are available for the active account and map to the migrated plugin identity. |

Migration is the durable install/eligibility step:

- During planning, OpenClaw reads source Codex `plugin/read` details and
  checks that the source Codex app-server account is a ChatGPT subscription
  account. A non-ChatGPT or missing account response skips app-backed
  plugins with `codex_subscription_required`.
- By default, migration skips the source `app/list` call: app-backed source
  plugins that pass the account gate are planned without source app
  accessibility verification, and account-lookup transport failures skip
  with `codex_account_unavailable`.
- With `--verify-plugin-apps`, migration takes a fresh source `app/list`
  snapshot and requires every owned app to be present, enabled, and
  accessible before planning native activation. Account-lookup transport
  failures then fall through to the source app-inventory gate instead of
  skipping outright.

Runtime app inventory is the target-session accessibility check that runs
after migration. Codex harness session setup computes a restrictive thread
app config from the enabled and accessible plugin apps; it is not
recomputed on every turn, so `/codex plugins enable`/`disable` only affect
new Codex conversations. Use `/new` or `/reset` to pick up the change in the
current conversation.

## V1 support boundary

- Only `openai-curated` plugins already installed in the source Codex
  app-server inventory are migration-eligible.
- App-backed source plugins must pass the migration-time subscription gate.
  `--verify-plugin-apps` adds the source app-inventory gate. Subscription-gated
  accounts, and in verification mode inaccessible/disabled/missing source
  apps or app-inventory refresh failures, are reported as skipped manual
  items instead of enabled config entries. Unreadable plugin details are
  skipped before the app-inventory gate.
- Migration writes explicit plugin identities (`marketplaceName` and
  `pluginName`); it does not write local `marketplacePath` cache paths.
- `codexPlugins.enabled` is the only global enablement switch; there is no
  `plugins["*"]` wildcard or config key that grants arbitrary install
  authority.
- Unsupported marketplaces, cached plugin bundles, hooks, and Codex config
  files are preserved in the migration report for manual review, not
  activated automatically.

## App inventory and ownership

OpenClaw reads Codex app inventory through app-server `app/list`, caches it
in memory for one hour, and refreshes stale or missing entries
asynchronously. The cache is process-local; restarting the CLI or gateway
drops it, and OpenClaw rebuilds it from the next `app/list` read.

Migration and runtime use separate cache keys:

- Source migration verification uses the source Codex home and start
  options. It runs only with `--verify-plugin-apps` and forces a fresh
  source `app/list` traversal for that planning run.
- Target runtime setup uses the target agent's Codex app-server identity
  when building the thread app config. Plugin activation invalidates that
  target cache key, then force-refreshes it after `plugin/install`.

A plugin app is exposed only when OpenClaw can map it back to the migrated
plugin through stable ownership: an exact app id from plugin detail, a known
MCP server name, or unique stable metadata. Display-name-only or ambiguous
ownership is excluded until the next inventory refresh proves ownership.

## Thread app config

OpenClaw injects a restrictive `config.apps` patch for the Codex thread:
`_default` is disabled, and only apps owned by enabled migrated plugins are
enabled.

`destructive_enabled` on each app comes from the effective global or
per-plugin `allow_destructive_actions` policy; `true`, `"auto"`, and `"ask"`
all set `destructive_enabled: true`, and `false` sets it `false`. Codex still
enforces destructive tool metadata from its native app tool annotations.
`_default` is disabled with `open_world_enabled: false`; enabled plugin apps
get `open_world_enabled: true`. OpenClaw does not expose a separate
plugin-level open-world policy knob and does not maintain per-plugin
destructive tool-name deny lists.

Tool approval mode defaults to automatic for plugin apps, so non-destructive
read tools run without a same-thread approval prompt. Destructive tools stay
controlled by each app's `destructive_enabled` policy.

## Destructive action policy

Destructive plugin elicitations are allowed by default for migrated Codex
plugins, while unsafe schemas and ambiguous ownership fail closed:

- Global `allow_destructive_actions` defaults to `true`.
- Per-plugin `allow_destructive_actions` overrides the global policy for
  that plugin.
- `false`: OpenClaw returns a deterministic decline.
- `true`: OpenClaw auto-accepts only safe schemas it can map to an approval
  response, such as a boolean approve field.
- `"auto"`: OpenClaw exposes destructive plugin actions to Codex, then
  turns ownership-proven MCP approval elicitations into OpenClaw plugin
  approvals before returning the Codex approval response.
- `"ask"`: OpenClaw uses the same Codex write/destructive gating as
  `"auto"`, clears durable Codex per-tool approval overrides for the app
  before the thread starts, and offers only one-shot approval or denial so
  durable approvals cannot suppress later write-action prompts. For each
  admitted app using `"ask"`, OpenClaw selects Codex's human approvals
  reviewer for that app so Codex sends its approval elicitations to
  OpenClaw; other apps and non-app thread approvals keep their configured
  reviewer and policy.
- Missing plugin identity, ambiguous ownership, a missing or mismatched
  turn id, or an unsafe elicitation schema declines instead of prompting.

## Troubleshooting

| Code                                              | Meaning                                                                                                                              | Fix                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `auth_required`                                   | Migration installed the plugin, but one of its apps still needs authentication. The entry is written disabled until you reauthorize. | Reauthorize the app in Codex, then enable the plugin in OpenClaw.                                                      |
| `app_inaccessible`, `app_disabled`, `app_missing` | With `--verify-plugin-apps`, the source Codex app inventory did not show all owned apps as present, enabled, and accessible.         | Reauthorize or enable the app in Codex, then rerun migration with `--verify-plugin-apps`.                              |
| `app_inventory_unavailable`                       | Strict source app verification was requested but the source Codex app inventory refresh failed.                                      | Fix source Codex app-server access, or retry without `--verify-plugin-apps` to accept the faster account-gated plan.   |
| `codex_subscription_required`                     | The source Codex app-server account was not a ChatGPT subscription account.                                                          | Log in to the Codex app with subscription auth, then rerun migration.                                                  |
| `codex_account_unavailable`                       | The source Codex app-server account could not be read.                                                                               | Fix source Codex app-server auth, or rerun with `--verify-plugin-apps` to let source app inventory decide eligibility. |
| `marketplace_missing`, `plugin_missing`           | The target Codex app-server cannot see the expected `openai-curated` marketplace or plugin.                                          | Rerun migration against the target runtime, or inspect Codex app-server plugin status.                                 |
| `app_inventory_missing`, `app_inventory_stale`    | App readiness came from an empty or stale cache.                                                                                     | OpenClaw schedules an async refresh automatically; plugin apps stay excluded until ownership and readiness are known.  |
| `app_ownership_ambiguous`                         | App inventory only matched by display name.                                                                                          | The app stays hidden from the Codex thread until a later refresh proves ownership.                                     |

**Config changed but the agent cannot see the plugin:** run `/codex plugins
list` to confirm the configured state, then `/new` or `/reset`. Existing
Codex thread bindings keep the app config they started with until OpenClaw
establishes a new harness session or replaces a stale binding.

**Destructive action is declined:** check the global and per-plugin
`allow_destructive_actions` values. Even with `true`, `"auto"`, or `"ask"`,
unsafe elicitation schemas and ambiguous plugin identity still fail closed.

## Related

- [Codex harness](/plugins/codex-harness)
- [Codex harness reference](/plugins/codex-harness-reference)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [Configuration reference](/gateway/configuration-reference#codex-harness-plugin-config)
- [Migrate CLI](/cli/migrate)
