---
summary: "Compatible Codex/Claude bundle formats: detection, mapping, and current OpenClaw support"
read_when:
  - You want to install or debug a Codex/Claude-compatible bundle
  - You need to understand how OpenClaw maps bundle content into native features
  - You are documenting bundle compatibility or current support limits
title: "Plugin Bundles"
---

# Plugin bundles

OpenClaw supports three **compatible bundle formats** in addition to native
OpenClaw plugins:

- Codex bundles
- Claude bundles
- Cursor bundles

OpenClaw shows both as `Format: bundle` in `openclaw plugins list`. Verbose
output and `openclaw plugins info <id>` also show the bundle subtype
(`codex`, `claude`, or `cursor`).

Related:

- Plugin system overview: [Plugins](/tools/plugin)
- CLI install/list flows: [plugins](/cli/plugins)
- Native manifest schema: [Plugin manifest](/plugins/manifest)

## What a bundle is

A bundle is a **content/metadata pack**, not a native in-process OpenClaw
plugin.

Today, OpenClaw does **not** execute bundle runtime code in-process. Instead,
it detects known bundle files, reads the metadata, and maps supported bundle
content into native OpenClaw surfaces such as skills, hook packs, and embedded
Pi settings.

That is the main trust boundary:

- native OpenClaw plugin: runtime module executes in-process
- bundle: metadata/content pack, with selective feature mapping

## Supported bundle formats

### Codex bundles

Typical markers:

- `.codex-plugin/plugin.json`
- optional `skills/`
- optional `hooks/`
- optional `.mcp.json`
- optional `.app.json`

### Claude bundles

OpenClaw supports both:

- manifest-based Claude bundles: `.claude-plugin/plugin.json`
- manifestless Claude bundles that use the default component layout

Default Claude layout markers OpenClaw recognizes:

- `skills/`
- `commands/`
- `agents/`
- `hooks/hooks.json`
- `.mcp.json`
- `.lsp.json`
- `settings.json`

### Cursor bundles

Typical markers:

- `.cursor-plugin/plugin.json`
- optional `skills/`
- optional `.cursor/commands/`
- optional `.cursor/agents/`
- optional `.cursor/rules/`
- optional `.cursor/hooks.json`
- optional `.mcp.json`

## Detection order

OpenClaw prefers native OpenClaw plugin/package layouts before bundle handling.

Practical effect:

- `openclaw.plugin.json` wins over bundle detection
- package installs with valid `package.json` + `openclaw.extensions` use the
  native install path
- if a directory contains both native and bundle metadata, OpenClaw treats it
  as native first

That avoids partially installing a dual-format package as a bundle and then
loading it later as a native plugin.

## Current mapping

OpenClaw normalizes bundle metadata into one internal bundle record, then maps
supported surfaces into existing native behavior.

### Supported now

#### Skills

- Codex `skills` roots load as normal OpenClaw skill roots
- Claude `skills` roots load as normal OpenClaw skill roots
- Claude `commands` roots are treated as additional skill roots
- Cursor `skills` roots load as normal OpenClaw skill roots
- Cursor `.cursor/commands` roots are treated as additional skill roots

This means Claude markdown command files work through the normal OpenClaw skill
loader. Cursor command markdown works through the same path.

#### Hook packs

- Codex `hooks` roots work **only** when they use the normal OpenClaw hook-pack
  layout:
  - `HOOK.md`
  - `handler.ts` or `handler.js`

#### Embedded Pi settings

- Claude `settings.json` is imported as default embedded Pi settings when the
  bundle is enabled
- OpenClaw sanitizes shell override keys before applying them

Sanitized keys:

- `shellPath`
- `shellCommandPrefix`

### Detected but not executed

These surfaces are detected, shown in bundle capabilities, and may appear in
diagnostics/info output, but OpenClaw does not run them yet:

- Claude `agents`
- Claude `hooks.json` automation
- Claude `mcpServers`
- Claude `lspServers`
- Claude `outputStyles`
- Cursor `.cursor/agents`
- Cursor `.cursor/hooks.json`
- Cursor `.cursor/rules`
- Cursor `mcpServers`
- Codex inline/app metadata beyond capability reporting

## Claude path behavior

Claude bundle manifests can declare custom component paths. OpenClaw treats
those paths as **additive**, not replacing defaults.

Currently recognized custom path keys:

- `skills`
- `commands`
- `agents`
- `hooks`
- `mcpServers`
- `lspServers`
- `outputStyles`

Examples:

- default `commands/` plus manifest `commands: "extra-commands"` =>
  OpenClaw scans both
- default `skills/` plus manifest `skills: ["team-skills"]` =>
  OpenClaw scans both

## Capability reporting

`openclaw plugins info <id>` shows bundle capabilities from the normalized
bundle record.

Supported capabilities are loaded quietly. Unsupported capabilities produce a
warning such as:

```text
bundle capability detected but not wired into OpenClaw yet: agents
```

Current exceptions:

- Claude `commands` is considered supported because it maps to skills
- Claude `settings` is considered supported because it maps to embedded Pi settings
- Cursor `commands` is considered supported because it maps to skills
- Codex `hooks` is considered supported only for OpenClaw hook-pack layouts

## Security model

Bundle support is intentionally narrower than native plugin support.

Current behavior:

- bundle discovery reads files inside the plugin root with boundary checks
- skills and hook-pack paths must stay inside the plugin root
- bundle settings files are read with the same boundary checks
- OpenClaw does not execute arbitrary bundle runtime code in-process

This makes bundle support safer by default than native plugin modules, but you
should still treat third-party bundles as trusted content for the features they
do expose.

## Install examples

```bash
openclaw plugins install ./my-codex-bundle
openclaw plugins install ./my-claude-bundle
openclaw plugins install ./my-cursor-bundle
openclaw plugins install ./my-bundle.tgz
openclaw plugins info my-bundle
```

If the directory is a native OpenClaw plugin/package, the native install path
still wins.

## Troubleshooting

### Bundle is detected but capabilities do not run

Check `openclaw plugins info <id>`.

If the capability is listed but OpenClaw says it is not wired yet, that is a
real product limit, not a broken install.

### Claude command files do not appear

Make sure the bundle is enabled and the markdown files are inside a detected
`commands` root or `skills` root.

### Claude settings do not apply

Current support is limited to embedded Pi settings from `settings.json`.
OpenClaw does not treat bundle settings as raw OpenClaw config patches.

### Claude hooks do not execute

`hooks/hooks.json` is only detected today.

If you need runnable bundle hooks today, use the normal OpenClaw hook-pack
layout through a supported Codex hook root or ship a native OpenClaw plugin.
