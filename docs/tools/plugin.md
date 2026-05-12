---
summary: "Install, configure, and manage OpenClaw plugins"
read_when:
  - Installing or configuring plugins
  - Understanding plugin discovery and load rules
  - Working with Codex/Claude-compatible plugin bundles
title: "Plugins"
sidebarTitle: "Install and Configure"
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

## Quick start

<Steps>
  <Step title="Find the plugin">
    Search [ClawHub](/clawhub) for public plugin packages:

    ```bash
    openclaw plugins search "calendar"
    ```

    ClawHub is the primary discovery surface for community plugins. During the
    launch cutover, ordinary bare package specs still install from npm. Use an
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

  </Step>

  <Step title="Restart the Gateway">
    ```bash
    openclaw gateway restart
    ```

    Installing, updating, or uninstalling plugin code requires a Gateway
    restart. Enable and disable operations update config and refresh the cold
    registry, but a restart is still the clearest verification path for live
    runtime surfaces.

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

## Choose an install source

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
ordinary bare package specs install through npm during the launch cutover. Use
`clawhub:`, `npm:`, `git:`, or `npm-pack:` when you need deterministic source
selection. See [`openclaw plugins`](/cli/plugins#install) for the full command
contract.

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

## Configure plugin policy

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
  work.
- `plugins.deny` wins over allow and per-plugin enablement.
- `plugins.allow` is an exclusive allowlist. Plugin-owned tools outside the
  allowlist stay unavailable, even when `tools.allow` includes `"*"`.
- `plugins.entries.<id>.enabled: false` disables one plugin while preserving its
  config.
- `plugins.load.paths` adds explicit local plugin files or directories.
- `plugins.slots` chooses one plugin for exclusive categories such as memory.

Run `openclaw doctor` or `openclaw doctor --fix` when config validation reports
stale plugin ids, allowlist/tool mismatches, or legacy bundled plugin paths.

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

On VPS or container installs, make sure the process you restart is the actual
`openclaw gateway run` child that serves your channels, not only a wrapper or
supervisor.

## Troubleshoot common install and config failures

| Symptom                                                        | Check                                                                                                                          | Fix                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Plugin appears in `plugins list` but runtime hooks do not run  | Use `openclaw plugins inspect <id> --runtime --json` and confirm the active Gateway with `gateway status --deep --require-rpc` | Restart the live Gateway after install, update, config, or source changes                               |
| Config says a plugin is missing                                | Check [Plugin inventory](/plugins/plugin-inventory) for whether it is bundled, official external, or source-only               | Install the external package, enable the bundled plugin, or remove stale config                         |
| Config is invalid during install                               | Read the validation message and run `openclaw doctor --fix` when it points to stale plugin state                               | Doctor can quarantine invalid plugin config by disabling the entry and removing the invalid payload     |
| Plugin path is blocked for suspicious ownership or permissions | Inspect the diagnostic before the config error                                                                                 | Fix filesystem ownership/permissions, then run `openclaw plugins registry --refresh`                    |
| `OPENCLAW_NIX_MODE=1` blocks lifecycle commands                | Confirm the install is managed by Nix                                                                                          | Change plugin selection in the Nix source instead of using plugin mutator commands                      |
| Dependency import fails at runtime                             | Check whether the plugin was installed through npm/git/ClawHub or loaded from a local path                                     | Run `openclaw plugins update <id>`, reinstall the source, or install local plugin dependencies yourself |

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

If one plugin dominates the timing, inspect its runtime registrations:

```bash
openclaw plugins inspect <plugin-id> --runtime --json
```

Then update, reinstall, or disable that plugin. Plugin authors should move
expensive dependency loading behind the tool execution path instead of doing it
inside the tool factory.

For dependency roots, package metadata validation, registry records, startup
reload behavior, and legacy cleanup, see
[Plugin dependency resolution](/plugins/dependency-resolution).

## Related

- [Manage plugins](/plugins/manage-plugins) - command examples for list, install, update, uninstall, and publish
- [`openclaw plugins`](/cli/plugins) - full CLI reference
- [Plugin inventory](/plugins/plugin-inventory) - generated bundled and external plugin list
- [Plugin reference](/plugins/reference) - generated per-plugin reference pages
- [Community plugins](/plugins/community) - ClawHub discovery and docs PR policy
- [Plugin dependency resolution](/plugins/dependency-resolution) - install roots, registry records, and runtime boundaries
- [Building plugins](/plugins/building-plugins) - native plugin authoring guide
- [Plugin manifest](/plugins/manifest) - manifest and package metadata
