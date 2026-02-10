---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw plugins` (list, install, enable/disable, doctor)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to install or manage in-process Gateway plugins（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to debug plugin load failures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "plugins"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw plugins`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage Gateway plugins/extensions (loaded in-process).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin system: [Plugins](/tools/plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin manifest + schema: [Plugin manifest](/plugins/manifest)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security hardening: [Security](/gateway/security)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins info <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins enable <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins disable <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins update <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins update --all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bundled plugins ship with OpenClaw but start disabled. Use `plugins enable` to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
activate them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All plugins must ship a `openclaw.plugin.json` file with an inline JSON Schema（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(`configSchema`, even if empty). Missing/invalid manifests or schemas prevent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the plugin from loading and fail config validation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install <path-or-spec>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security note: treat plugin installs like running code. Prefer pinned versions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--link` to avoid copying a local directory (adds to `plugins.load.paths`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install -l ./my-plugin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins update <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins update --all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins update <id> --dry-run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Updates only apply to plugins installed from npm (tracked in `plugins.installs`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
