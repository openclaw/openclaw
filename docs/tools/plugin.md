---
summary: "Install, configure, and manage OpenClaw plugins"
read_when:
  - Installing or configuring plugins
  - Understanding plugin discovery and load rules
  - Working with Codex/Claude-compatible plugin bundles
title: "Plugins"
sidebarTitle: "Getting Started"
doc-schema-version: 1
---

Plugins extend OpenClaw with channels, model providers, agent harnesses, tools,
skills, speech, realtime transcription, voice, media understanding, generation,
web fetch, web search, and other runtime capabilities.

Use this page when you want to install a plugin, restart the Gateway, verify
that the runtime loaded it, and route common setup failures. For command-only
examples, see [Manage plugins](/plugins/manage-plugins). For the full generated
inventory of bundled, official external, and source-only plugins, see
[Plugin inventory](/plugins/plugin-inventory).

## Requirements

Before installing a plugin, make sure you have:

- an OpenClaw checkout or installation with the `openclaw` CLI available
- network access to the selected source, such as ClawHub, npm, or a git host
- any plugin-specific credentials, config keys, or operating-system tools named
  by that plugin's setup docs
- permission for the Gateway that serves your channels to reload or restart

## Quick start

<Steps>
  <Step title="Find the plugin">
    Search [ClawHub](/clawhub) for public plugin packages:

    ```bash
    openclaw plugins search "calendar"
    ```

    ClawHub is the primary discovery surface for community plugins. During the
    launch cutover, ordinary bare package specs still install from npm unless
    they match an official plugin id. Raw `@openclaw/*` package specs that match
    bundled plugins use the bundled copy from the current OpenClaw build. Use an
    explicit prefix when you need one source.

  </Step>

  <Step title="Install the plugin">
    ```bash
    # From ClawHub.
    openclaw plugins install clawhub:<package>

    # From npm.
    openclaw plugins install npm:<package>

    # From git.
    openclaw plugins install git:github.com/<owner>/<repo>@<ref>

    # From a local development checkout.
    openclaw plugins install ./my-plugin
    openclaw plugins install --link ./my-plugin
    ```

    Treat plugin installs like running code. Prefer pinned versions when you
    need reproducible production installs.

  </Step>

  <Step title="Configure and enable it">
    Configure plugin-specific settings under `plugins.entries.<id>.config`.
    Enable the plugin when it is not already enabled:

    ```bash
    openclaw plugins enable <plugin-id>
    ```

    If your config uses a restrictive `plugins.allow` list, the installed plugin
    id must be present there before the plugin can load.
    `openclaw plugins install` adds the installed id to an existing
    `plugins.allow` list and removes the same id from `plugins.deny` so the
    explicit install can load after restart.

  </Step>

  <Step title="Let the Gateway reload">
    Installing, updating, or uninstalling plugin code requires a Gateway
    restart. When a managed Gateway is already running with config reload
    enabled, OpenClaw detects the changed plugin install record and restarts the
    Gateway automatically. If the Gateway is not managed or reload is disabled,
    restart it yourself:

    ```bash
    openclaw gateway restart
    ```

    Enable and disable operations update config and refresh the cold registry.
    A runtime inspect is still the clearest verification path for live runtime
    surfaces.

  </Step>

  <Step title="Verify runtime registration">
    ```bash
    openclaw plugins inspect <plugin-id> --runtime --json
    ```

    Use `--runtime` when you need to prove registered tools, hooks, services,
    Gateway methods, or plugin-owned CLI commands. Plain `inspect` is a cold
    manifest and registry check.

  </Step>
</Steps>

## Configuration

### Choose an install source

| Source      | Use when                                                                       | Example                                                        |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| ClawHub     | You want OpenClaw-native discovery, scans, version metadata, and install hints | `openclaw plugins install clawhub:<package>`                   |
| npm         | You need direct npm registry or dist-tag workflows                             | `openclaw plugins install npm:<package>`                       |
| git         | You need a branch, tag, or commit from a repository                            | `openclaw plugins install git:github.com/<owner>/<repo>@<ref>` |
| local path  | You are developing or testing a plugin on the same machine                     | `openclaw plugins install --link ./my-plugin`                  |
| marketplace | You are installing a Claude-compatible marketplace plugin                      | `openclaw plugins install <plugin> --marketplace <source>`     |

Bare package specs have special compatibility behavior. If the bare name matches
a bundled plugin id, OpenClaw uses that bundled source. If it matches an
official external plugin id, OpenClaw uses the official package catalog. Other
ordinary bare package specs install through npm during the launch cutover. Raw
`@openclaw/*` package specs that match bundled plugins also resolve to the
bundled copy before npm fallback. Use `npm:@openclaw/<plugin>@<version>` when
you deliberately want the external npm package instead of the image-owned
bundled copy. Use `clawhub:`, `npm:`, `git:`, or `npm-pack:` when you need
deterministic source selection. See [`openclaw plugins`](/cli/plugins#install)
for the full command contract.

For npm installs, unpinned package specs and `@latest` choose the newest stable
package that advertises compatibility with this OpenClaw build. If npm's
current latest release declares a newer `openclaw.compat.pluginApi` or
`openclaw.install.minHostVersion`, OpenClaw scans older stable package versions
and installs the newest one that fits. Exact versions and explicit channel tags
such as `@beta` stay pinned to the selected package and fail when incompatible.

### Configure plugin policy

The common plugin config shape is:

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-plugin"] },
    slots: { memory: "memory-core" },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

Key policy rules:

- `plugins.enabled: false` disables all plugins and skips plugin discovery/load
  work. Stale plugin references are inert while this is active; re-enable
  plugins before running doctor cleanup when you want stale ids removed.
- `plugins.deny` wins over allow and per-plugin enablement.
- `plugins.allow` is an exclusive allowlist. Plugin-owned tools outside the
  allowlist stay unavailable, even when `tools.allow` includes `"*"`.
- `plugins.entries.<id>.enabled: false` disables one plugin while preserving its
  config.
- `plugins.load.paths` adds explicit local plugin files or directories.
- Workspace-origin plugins are disabled by default; explicitly enable or
  allowlist them before using local workspace code.
- Bundled plugins follow their built-in default-on/default-off metadata unless
  config explicitly overrides them.
- `plugins.slots.<slot>` chooses one plugin for exclusive categories such as
  memory and context engines. Slot selection force-enables the selected plugin
  for that slot by counting as explicit activation; it can load even when it
  would otherwise be opt-in. `plugins.deny` and
  `plugins.entries.<id>.enabled: false` still block it.
- Bundled opt-in plugins can auto-activate when config names one of their owned
  surfaces, such as a provider/model ref, channel config, CLI backend, or agent
  harness runtime.
- OpenAI-family Codex routing keeps provider and runtime plugin boundaries
  separate: legacy Codex model refs are legacy config repaired by doctor, while the bundled
  `codex` plugin owns Codex app-server runtime for canonical `openai/*` agent
  refs, explicit `agentRuntime.id: "codex"`, and legacy `codex/*` refs.

Run `openclaw doctor` or `openclaw doctor --fix` when config validation reports
stale plugin ids, allowlist/tool mismatches, or legacy bundled plugin paths.

## Understand plugin formats

OpenClaw recognizes two plugin formats:

| Format                 | How it loads                                                                 | Use when                                                               |
| ---------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Native OpenClaw plugin | `openclaw.plugin.json` plus a runtime module loaded in process               | You are installing or building OpenClaw-specific runtime capabilities  |
| Compatible bundle      | Codex, Claude, or Cursor plugin layout mapped into OpenClaw plugin inventory | You are reusing compatible skills, commands, hooks, or bundle metadata |

Both formats appear in `openclaw plugins list`, `openclaw plugins inspect`,
`openclaw plugins enable`, and `openclaw plugins disable`. See
[Plugin bundles](/plugins/bundles) for the bundle compatibility boundary and
[Building plugins](/plugins/building-plugins) for native plugin authoring.

## Plugin hooks

Plugins can register hooks at runtime, but there are two different APIs with
different jobs.

- Use typed hooks via `api.on(...)` for runtime lifecycle hooks. This is the
  preferred surface for middleware, policy, message rewriting, prompt shaping,
  and tool control.
- Use `api.registerHook(...)` only when you want to participate in the internal
  hook system described in [Hooks](/automation/hooks). This is mainly for coarse
  command/lifecycle side effects and compatibility with existing HOOK-style
  automation.

Quick rule:

- If the handler needs priority, merge semantics, or block/cancel behavior, use
  typed plugin hooks.
- If the handler just reacts to `command:new`, `command:reset`, `message:sent`,
  or similar coarse events, `api.registerHook(...)` is fine.

Plugin-managed internal hooks show up in `openclaw hooks list` with
`plugin:<id>`. You cannot enable or disable them through `openclaw hooks`;
enable or disable the plugin instead.

## Verify the active Gateway

`openclaw plugins list` and plain `openclaw plugins inspect` read cold config,
manifest, and registry state. They do not prove that an already-running Gateway
has imported the same plugin code.

When a plugin appears installed but live chat traffic does not use it:

```bash
openclaw gateway status --deep --require-rpc
openclaw plugins inspect <plugin-id> --runtime --json
openclaw gateway restart
```

Managed Gateways restart automatically after plugin install, update, and
uninstall changes that alter plugin source. On VPS or container installs, make
sure any manual restart targets the actual `openclaw gateway run` child that
serves your channels, not only a wrapper or supervisor.

## Troubleshooting

| Symptom                                                        | Check                                                                                                                                      | Fix                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Plugin appears in `plugins list` but runtime hooks do not run  | Use `openclaw plugins inspect <id> --runtime --json` and confirm the active Gateway with `gateway status --deep --require-rpc`             | Restart the live Gateway after install, update, config, or source changes                               |
| Duplicate channel or tool ownership diagnostics appear         | Run `openclaw plugins list --enabled --verbose`, inspect each suspected plugin with `--runtime --json`, and compare channel/tool ownership | Disable one owner, remove stale installs, or use manifest `preferOver` for intentional replacement      |
| Config says a plugin is missing                                | Check [Plugin inventory](/plugins/plugin-inventory) for whether it is bundled, official external, or source-only                           | Install the external package, enable the bundled plugin, or remove stale config                         |
| Config is invalid during install                               | Read the validation message and run `openclaw doctor --fix` when it points to stale plugin state                                           | Doctor can quarantine invalid plugin config by disabling the entry and removing the invalid payload     |
| Plugin path is blocked for suspicious ownership or permissions | Inspect the diagnostic before the config error                                                                                             | Fix filesystem ownership/permissions, then run `openclaw plugins registry --refresh`                    |
| `OPENCLAW_NIX_MODE=1` blocks lifecycle commands                | Confirm the install is managed by Nix                                                                                                      | Change plugin selection in the Nix source instead of using plugin mutator commands                      |
| Dependency import fails at runtime                             | Check whether the plugin was installed through npm/git/ClawHub or loaded from a local path                                                 | Run `openclaw plugins update <id>`, reinstall the source, or install local plugin dependencies yourself |

When stale plugin config still names a no-longer-discoverable channel plugin,
Gateway startup skips that plugin-backed channel instead of blocking every
other channel. Run `openclaw doctor --fix` to remove stale plugin and channel
entries. Unknown channel keys without stale-plugin evidence still fail
validation so typos stay visible.

For intentional channel replacement, the preferred plugin should declare
`channelConfigs.<channel-id>.preferOver` with the legacy or lower-priority
plugin id. If both plugins are explicitly enabled, OpenClaw keeps that request
and reports duplicate channel or tool diagnostics instead of silently choosing
one owner.

If an installed package reports that it `requires compiled runtime output for
TypeScript entry ...`, the package was published without the JavaScript files
OpenClaw needs at runtime. Update or reinstall after the publisher ships
compiled JavaScript, or disable/uninstall the plugin until then.

### Blocked plugin path ownership

If plugin diagnostics say
`blocked plugin candidate: suspicious ownership (... uid=1000, expected uid=0 or root)`
and config validation follows with `plugin present but blocked`, OpenClaw found
plugin files owned by a different Unix user than the process that is loading
them. Keep the plugin config in place; fix the filesystem ownership or run
OpenClaw as the same user that owns the state directory.

For Docker installs, the official image runs as `node` (uid `1000`), so the
host bind-mounted OpenClaw config and workspace directories should normally be
owned by uid `1000`:

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

If you intentionally run OpenClaw as root, repair the managed plugin root to
root ownership instead:

```bash
sudo chown -R root:root /path/to/openclaw-config/npm
```

After fixing ownership, rerun `openclaw doctor --fix` or
`openclaw plugins registry --refresh` so the persisted plugin registry matches
the repaired files.

### Slow plugin tool setup

If agent turns appear to stall while preparing tools, enable trace logging and
check for plugin tool factory timing lines:

```bash
openclaw config set logging.level trace
openclaw logs --follow
```

Look for:

```text
[trace:plugin-tools] factory timings ...
```

The summary lists total factory time and the slowest plugin tool factories,
including plugin id, declared tool names, result shape, and whether the tool is
optional. Slow lines are promoted to warnings when a single factory takes at
least 1s or total plugin tool factory prep takes at least 5s.

OpenClaw caches successful plugin tool factory results for repeated resolutions
with the same effective request context. The cache key includes the effective
runtime config, workspace, agent/session ids, sandbox policy, browser settings,
delivery context, requester identity, and ownership state, so factories that
depend on those trusted fields are re-run when the context changes. If timings
stay high, the plugin may be doing expensive work before returning its tool
definitions.

If one plugin dominates the timing, inspect its runtime registrations:

```bash
openclaw plugins inspect <plugin-id> --runtime --json
```

Then update, reinstall, or disable that plugin. Plugin authors should move
expensive dependency loading behind the tool execution path instead of doing it
inside the tool factory.

### Duplicate channel or tool ownership

Symptoms:

- `channel already registered: <channel-id> (<plugin-id>)`
- `channel setup already registered: <channel-id> (<plugin-id>)`
- `plugin tool name conflict (<plugin-id>): <tool-name>`

These mean more than one enabled plugin is trying to own the same channel,
setup flow, or tool name. The most common cause is an external channel plugin
installed beside a bundled plugin that now provides the same channel id.

Debug steps:

- Run `openclaw plugins list --enabled --verbose` to see every enabled plugin
  and origin.
- Run `openclaw plugins inspect <id> --runtime --json` for each suspected plugin and
  compare `channels`, `channelConfigs`, `tools`, and diagnostics.
- Run `openclaw plugins registry --refresh` after installing or removing
  plugin packages so persisted metadata reflects the current install.
- Restart the Gateway after install, registry, or config changes.

Fix options:

- If one plugin intentionally replaces another for the same channel id, the
  preferred plugin should declare `channelConfigs.<channel-id>.preferOver` with
  the lower-priority plugin id. See [/plugins/manifest#replacing-another-channel-plugin](/plugins/manifest#replacing-another-channel-plugin).
- If the duplicate is accidental, disable one side with
  `plugins.entries.<plugin-id>.enabled: false` or remove the stale plugin
  install.
- If you explicitly enabled both plugins, OpenClaw keeps that request and
  reports the conflict. Pick one owner for the channel or rename plugin-owned
  tools so the runtime surface is unambiguous.

## Plugin slots (exclusive categories)

Some categories are exclusive (only one active at a time):

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable
      contextEngine: "legacy", // or a plugin id
    },
  },
}
```

| Slot            | What it controls      | Default             |
| --------------- | --------------------- | ------------------- |
| `memory`        | Active memory plugin  | `memory-core`       |
| `contextEngine` | Active context engine | `legacy` (built-in) |

## CLI reference

```bash
openclaw plugins list                       # compact inventory
openclaw plugins list --enabled            # only enabled plugins
openclaw plugins list --verbose            # per-plugin detail lines
openclaw plugins list --json               # machine-readable inventory
openclaw plugins search <query>            # search ClawHub plugin catalog
openclaw plugins inspect <id>              # static detail
openclaw plugins inspect <id> --runtime    # registered hooks/tools/CLI/gateway methods
openclaw plugins inspect <id> --json       # machine-readable
openclaw plugins inspect --all             # fleet-wide table
openclaw plugins info <id>                 # inspect alias
openclaw plugins doctor                    # diagnostics
openclaw plugins registry                  # inspect persisted registry state
openclaw plugins registry --refresh        # rebuild persisted registry
openclaw doctor --fix                      # repair plugin registry state

openclaw plugins install <package>         # install from npm by default
openclaw plugins install clawhub:<pkg>     # install from ClawHub only
openclaw plugins install npm:<pkg>         # install from npm only
openclaw plugins install git:<repo>        # install from git
openclaw plugins install git:<repo>@<ref>  # install from git ref
openclaw plugins install <spec> --force    # overwrite existing install
openclaw plugins install <path>            # install from local path
openclaw plugins install -l <path>         # link (no copy) for dev
openclaw plugins install <plugin> --marketplace <source>
openclaw plugins install <plugin> --marketplace https://github.com/<owner>/<repo>
openclaw plugins install <spec> --pin      # record exact resolved npm spec
openclaw plugins install <spec> --dangerously-force-unsafe-install
openclaw plugins update <id-or-npm-spec> # update one plugin
openclaw plugins update <id-or-npm-spec> --dangerously-force-unsafe-install
openclaw plugins update --all            # update all
openclaw plugins uninstall <id>          # remove config and plugin index records
openclaw plugins uninstall <id> --keep-files
openclaw plugins marketplace list <source>
openclaw plugins marketplace list <source> --json

# Verify runtime registrations after install.
openclaw plugins inspect <id> --runtime --json

# Run plugin-owned CLI commands directly from the OpenClaw root CLI.
openclaw <plugin-command> --help

openclaw plugins enable <id>
openclaw plugins disable <id>
```

Bundled plugins ship with OpenClaw. Many are enabled by default (for example
bundled model providers, bundled speech providers, and the bundled browser
plugin). Other bundled plugins still need `openclaw plugins enable <id>`.

`--force` overwrites an existing installed plugin or hook pack in place. Use
`openclaw plugins update <id-or-npm-spec>` for routine upgrades of tracked npm
plugins. It is not supported with `--link`, which reuses the source path instead
of copying over a managed install target.

When `plugins.allow` is already set, `openclaw plugins install` adds the
installed plugin id to that allowlist before enabling it. If the same plugin id
is present in `plugins.deny`, install removes that stale deny entry so the
explicit install is immediately loadable after restart.

OpenClaw keeps a persisted local plugin registry as the cold read model for
plugin inventory, contribution ownership, and startup planning. Install, update,
uninstall, enable, and disable flows refresh that registry after changing plugin
state. The global SQLite database keeps durable install metadata in the typed
`installed_plugin_index` row: top-level `installRecords` plus
rebuildable manifest metadata in `plugins`. If the registry is missing, stale,
or invalid, `openclaw plugins registry
--refresh` rebuilds its manifest view from install records, config policy, and
manifest/package metadata without loading plugin runtime modules.

In Nix mode (`OPENCLAW_NIX_MODE=1`), plugin lifecycle mutators are disabled.
Manage plugin package selection and config through the Nix source for the
install instead; for nix-openclaw, start with the agent-first
[Quick Start](https://github.com/openclaw/nix-openclaw#quick-start).
`openclaw plugins update <id-or-npm-spec>` applies to tracked installs. Passing
an npm package spec with a dist-tag or exact version resolves the package name
back to the tracked plugin record and records the new spec for future updates.
Passing the package name without a version moves an exact pinned install back to
the registry's default release line. If the installed npm plugin already matches
the resolved version and recorded artifact identity, OpenClaw skips the update
without downloading, reinstalling, or rewriting config.
When `openclaw update` runs on the beta channel, default-line npm and ClawHub
plugin records try `@beta` first and fall back to default/latest when no plugin
beta release exists. Exact versions and explicit tags stay pinned.

`--pin` is npm-only. It is not supported with `--marketplace`, because
marketplace installs persist marketplace source metadata instead of an npm spec.

`--dangerously-force-unsafe-install` is a break-glass override for false
positives from the built-in dangerous-code scanner. It allows plugin installs
and plugin updates to continue past built-in `critical` findings, but it still
does not bypass plugin `before_install` policy blocks or scan-failure blocking.
Install scans ignore common test files and directories such as `tests/`,
`__tests__/`, `*.test.*`, and `*.spec.*` to avoid blocking packaged test mocks;
declared plugin runtime entrypoints are still scanned even if they use one of
those names.

This CLI flag applies to plugin install/update flows only. Gateway-backed skill
dependency installs use the matching `dangerouslyForceUnsafeInstall` request
override instead, while `openclaw skills install` remains the separate ClawHub
skill download/install flow.

If a plugin you published on ClawHub is hidden or blocked by a scan, open the
ClawHub dashboard or run `clawhub package rescan <name>` to ask ClawHub to check
it again. `--dangerously-force-unsafe-install` only affects installs on your own
machine; it does not ask ClawHub to rescan the plugin or make a blocked release
public.

Compatible bundles participate in the same plugin list/inspect/enable/disable
flow. Current runtime support includes bundle skills, Claude command-skills,
Claude `settings.json` defaults, Claude `.lsp.json` and manifest-declared
`lspServers` defaults, Cursor command-skills, and compatible Codex hook
directories.

`openclaw plugins inspect <id>` also reports detected bundle capabilities plus
supported or unsupported MCP and LSP server entries for bundle-backed plugins.

Marketplace sources can be a Claude known-marketplace name from
`~/.claude/plugins/known_marketplaces.json`, a local marketplace root or
`marketplace.json` path, a GitHub shorthand like `owner/repo`, a GitHub repo
URL, or a git URL. For remote marketplaces, plugin entries must stay inside the
cloned marketplace repo and use relative path sources only.

See [`openclaw plugins` CLI reference](/cli/plugins) for full details.

## Plugin API overview

Native plugins export an entry object that exposes `register(api)`. Older
plugins may still use `activate(api)` as a legacy alias, but new plugins should
use `register`.

```typescript
export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  register(api) {
    api.registerProvider({
      /* ... */
    });
    api.registerTool({
      /* ... */
    });
    api.registerChannel({
      /* ... */
    });
  },
});
```

OpenClaw loads the entry object and calls `register(api)` during plugin
activation. The loader still falls back to `activate(api)` for older plugins,
but bundled plugins and new external plugins should treat `register` as the
public contract.

`api.registrationMode` tells a plugin why its entry is being loaded:

| Mode            | Meaning                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `full`          | Runtime activation. Register tools, hooks, services, commands, routes, and other live side effects.                              |
| `discovery`     | Read-only capability discovery. Register providers and metadata; trusted plugin entry code may load, but skip live side effects. |
| `setup-only`    | Channel setup metadata loading through a lightweight setup entry.                                                                |
| `setup-runtime` | Channel setup loading that also needs the runtime entry.                                                                         |
| `cli-metadata`  | CLI command metadata collection only.                                                                                            |

Plugin entries that open sockets, databases, background workers, or long-lived
clients should guard those side effects with `api.registrationMode === "full"`.
Discovery loads are cached separately from activating loads and do not replace
the running Gateway registry. Discovery is non-activating, not import-free:
OpenClaw may evaluate the trusted plugin entry or channel plugin module to build
the snapshot. Keep module top levels lightweight and side-effect-free, and move
network clients, subprocesses, listeners, credential reads, and service startup
behind full-runtime paths.

Common registration methods:

| Method                                  | What it registers           |
| --------------------------------------- | --------------------------- |
| `registerProvider`                      | Model provider (LLM)        |
| `registerChannel`                       | Chat channel                |
| `registerTool`                          | Agent tool                  |
| `registerHook` / `on(...)`              | Lifecycle hooks             |
| `registerSpeechProvider`                | Text-to-speech / STT        |
| `registerRealtimeTranscriptionProvider` | Streaming STT               |
| `registerRealtimeVoiceProvider`         | Duplex realtime voice       |
| `registerMediaUnderstandingProvider`    | Image/audio analysis        |
| `registerImageGenerationProvider`       | Image generation            |
| `registerMusicGenerationProvider`       | Music generation            |
| `registerVideoGenerationProvider`       | Video generation            |
| `registerWebFetchProvider`              | Web fetch / scrape provider |
| `registerWebSearchProvider`             | Web search                  |
| `registerHttpRoute`                     | HTTP endpoint               |
| `registerCommand` / `registerCli`       | CLI commands                |
| `registerContextEngine`                 | Context engine              |
| `registerService`                       | Background service          |

Hook guard behavior for typed lifecycle hooks:

- `before_tool_call`: `{ block: true }` is terminal; lower-priority handlers are skipped.
- `before_tool_call`: `{ block: false }` is a no-op and does not clear an earlier block.
- `before_install`: `{ block: true }` is terminal; lower-priority handlers are skipped.
- `before_install`: `{ block: false }` is a no-op and does not clear an earlier block.
- `message_sending`: `{ cancel: true }` is terminal; lower-priority handlers are skipped.
- `message_sending`: `{ cancel: false }` is a no-op and does not clear an earlier cancel.

Native Codex app-server runs bridge Codex-native tool events back into this
hook surface. Plugins can block native Codex tools through `before_tool_call`,
observe results through `after_tool_call`, and participate in Codex
`PermissionRequest` approvals. The bridge does not rewrite Codex-native tool
arguments yet. The exact Codex runtime support boundary lives in the
[Codex harness v1 support contract](/plugins/codex-harness-runtime#v1-support-contract).

For full typed hook behavior, see [SDK overview](/plugins/sdk-overview#hook-decision-semantics).

## Related

- [Manage plugins](/plugins/manage-plugins) - command examples for list, install, update, uninstall, and publish
- [`openclaw plugins`](/cli/plugins) - full CLI reference
- [Plugin inventory](/plugins/plugin-inventory) - generated bundled and external plugin list
- [Plugin reference](/plugins/reference) - generated per-plugin reference pages
- [Community plugins](/plugins/community) - ClawHub discovery and docs PR policy
- [Plugin dependency resolution](/plugins/dependency-resolution) - install roots, registry records, and runtime boundaries
- [Building plugins](/plugins/building-plugins) - native plugin authoring guide
- [Plugin SDK overview](/plugins/sdk-overview) - runtime registration, hooks, and API fields
- [Plugin manifest](/plugins/manifest) - manifest and package metadata
