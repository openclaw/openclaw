---
summary: "CLI reference for `dna plugins` (list, install, enable/disable, doctor)"
read_when:
  - You want to install or manage in-process Gateway plugins
  - You want to debug plugin load failures
---

# `dna plugins`

Manage Gateway plugins/extensions (loaded in-process).

Related:
- Plugin system: [Plugins](/plugin)
- Plugin manifest + schema: [Plugin manifest](/plugins/manifest)
- Security hardening: [Security](/gateway/security)

## Commands

```bash
dna plugins list
dna plugins info <id>
dna plugins enable <id>
dna plugins disable <id>
dna plugins doctor
dna plugins update <id>
dna plugins update --all
```

Bundled plugins ship with DNA but start disabled. Use `plugins enable` to
activate them.

All plugins must ship a `dna.plugin.json` file with an inline JSON Schema
(`configSchema`, even if empty). Missing/invalid manifests or schemas prevent
the plugin from loading and fail config validation.

### Install

```bash
dna plugins install <path-or-spec>
```

Security note: treat plugin installs like running code. Prefer pinned versions.

Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Use `--link` to avoid copying a local directory (adds to `plugins.load.paths`):

```bash
dna plugins install -l ./my-plugin
```

### Update

```bash
dna plugins update <id>
dna plugins update --all
dna plugins update <id> --dry-run
```

Updates only apply to plugins installed from npm (tracked in `plugins.installs`).
