---
title: "Plugin Troubleshooting"
sidebarTitle: "Troubleshooting"
summary: "Common plugin load, manifest, config, and registration problems and how to debug them"
read_when:
  - Your plugin is not loading or not showing up
  - A plugin loads but some tools or capabilities are missing
  - You need the shortest path to `inspect`, `doctor`, and the most common fixes
---

# Plugin Troubleshooting

Use this page when a plugin is installed but does not behave the way you
expect. Most problems show up quickly with `inspect`, `doctor`, and one check
of the manifest and config.

## Fast checks

Run these first:

```bash
openclaw plugins list
openclaw plugins inspect <id>
openclaw plugins doctor
openclaw gateway restart
```

What each one tells you:

- `plugins list` tells you whether discovery found the plugin at all.
- `plugins inspect <id>` shows load status, source, registrations, and diagnostics.
- `plugins doctor` surfaces manifest, config, and install problems.
- `gateway restart` applies config changes and reloads plugin code.

## Common problems

| Symptom                                     | Likely cause                              | What to check                                                           |
| ------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| Plugin never appears in `plugins list`      | Discovery never found it                  | Install path, `plugins.load.paths`, archive contents, or package layout |
| Plugin appears but is disabled              | Enablement rules turned it off            | `plugins.enabled`, `plugins.deny`, `plugins.entries.<id>.enabled`       |
| Plugin shows diagnostics about the manifest | Missing or invalid `openclaw.plugin.json` | `id`, `configSchema`, JSON syntax, manifest location                    |
| Plugin loads but some tools are missing     | Optional tool or setup-only load          | `tools.allow`, `api.registrationMode`, `inspect` output                 |
| Wrong plugin wins                           | Duplicate plugin id shadowing             | `inspect`, `doctor`, and duplicate-id diagnostics                       |
| Runtime warns about old imports             | Deprecated SDK surface                    | [Migrate to SDK](/plugins/sdk-migration)                                |

## Plugin does not show up at all

Check the package shape first:

- Native plugins must ship `openclaw.plugin.json` at the plugin root.
- `package.json` must point OpenClaw at the runtime entry via `openclaw.extensions`.
- If you linked or loaded a local folder, the path must point at the plugin
  root, not just a `src/` directory.

If the plugin still does not appear, run:

```bash
openclaw plugins doctor
```

Doctor will surface broken or missing manifests and other discovery problems.

## Plugin is found but not enabled

The most common cause is config, not code.

Check these in order:

- `plugins.enabled` is still `true`
- the plugin id is not in `plugins.deny`
- `plugins.entries.<id>.enabled` is not `false`
- workspace-origin plugins are explicitly enabled

Then restart the gateway:

```bash
openclaw gateway restart
```

## Manifest errors

For native plugins, these are hard requirements:

- `openclaw.plugin.json` must be valid JSON
- the manifest must include `id`
- the manifest must include `configSchema`, even if empty

Minimal safe schema:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false
  }
}
```

If the manifest is broken, OpenClaw treats the plugin as invalid and Doctor
surfaces a warning.

## Manifest id and entry id do not match

The manifest and exported plugin definition must describe the same plugin id.

If they differ, the loader reports a mismatch like:

```text
plugin id mismatch (config uses "my-plugin", export uses "other-id")
```

Keep the same id in:

- `openclaw.plugin.json`
- `definePluginEntry({ id: ... })` or `defineChannelPluginEntry({ id: ... })`
- config keys under `plugins.entries.<id>`

## Duplicate plugin ids

If two discovered plugins use the same id, one shadows the other. This usually
happens when you have both a bundled plugin and a local/dev copy with the same
id.

Look for duplicate-id diagnostics in:

```bash
openclaw plugins inspect <id>
openclaw plugins doctor
```

If you are building a local replacement, that may be intentional. If not,
rename the plugin id or remove the extra copy.

## Optional tools are missing

If you registered a tool with `{ optional: true }`, it does not appear by
default.

Allow it explicitly:

```json5
{
  tools: {
    allow: ["my_optional_tool"],
  },
}
```

Or allow the whole plugin by id:

```json5
{
  tools: {
    allow: ["my-plugin"],
  },
}
```

Then restart the gateway and run `openclaw plugins inspect <id>` again.

## Channel plugin only partly loads

Channel plugins can load in more than one registration mode:

- `"full"` for normal startup
- `"setup-only"` for disabled or unconfigured channels
- `"setup-runtime"` for setup flows that still need runtime helpers

If a channel plugin seems to register only setup behavior, inspect
`api.registrationMode` and move heavy registrations behind the correct mode
check. See [Plugin Entry Points](/plugins/sdk-entrypoints#registration-mode).

## Deprecated import warnings

If you see warnings about the old root barrel or extension-api bridge, move to
focused SDK subpaths:

- from `openclaw/plugin-sdk`
- to `openclaw/plugin-sdk/<subpath>`

Use:

- [Migrate to SDK](/plugins/sdk-migration)
- [SDK Subpaths](/plugins/sdk-subpaths)

## When to inspect deeper

If the quick fixes above do not explain the problem, the next pages are:

- [Plugins](/tools/plugin) — discovery, precedence, enablement rules
- [plugins CLI](/cli/plugins) — exact `inspect`, `install`, and `doctor` commands
- [Plugin Manifest](/plugins/manifest) — manifest schema requirements
- [Plugin Internals](/plugins/architecture) — load pipeline and registry behavior
