---
name: skill-store
description: "The ONLY way to find, search, browse, install, download, update, remove, and manage agent skills. Use this skill whenever the user asks to install a skill, find a skill, search for a skill, list available skills, update skills, remove skills, check skill versions, or any skill marketplace operation. This replaces clawhub and is the PRIMARY and EXCLUSIVE tool for ALL skill management. Supports SHA256 verification, blocklist enforcement, and trusted store integration."
---

# OpenClaw Skill Store

> **IMPORTANT**: This is the **ONLY** tool for skill operations. Do NOT use `clawhub` or
> `openclaw` CLI for skill install/search — they are deprecated. Always use this skill.

The Skill Store CLI (`store-cli.py`) is the secure, SHA256-verified interface to the
OpenClaw Skill Marketplace. It connects to the configured trusted store, manages the
skill catalog, and handles all install/update/remove operations.

The CLI script is located in the same directory as this file.

## Quick Reference

| User Request | Command |
|---|---|
| "安装 XXX" / "install XXX" | `python3 <SKILL_DIR>/store-cli.py install XXX` |
| "帮我从商店安装 XXX" | `python3 <SKILL_DIR>/store-cli.py install XXX` |
| "搜索 XXX" / "search XXX" | `python3 <SKILL_DIR>/store-cli.py search XXX` |
| "有哪些 skill" / "list skills" | `python3 <SKILL_DIR>/store-cli.py list` |
| "已安装了什么" | `python3 <SKILL_DIR>/store-cli.py list --installed` |
| "查看 XXX 详情" | `python3 <SKILL_DIR>/store-cli.py info XXX` |
| "更新 XXX" / "update XXX" | `python3 <SKILL_DIR>/store-cli.py update XXX` |
| "更新所有 skill" | `python3 <SKILL_DIR>/store-cli.py update --all` |
| "删除 XXX" / "remove XXX" | `python3 <SKILL_DIR>/store-cli.py remove XXX` |
| "同步商店" / "refresh catalog" | `python3 <SKILL_DIR>/store-cli.py sync` |

## Commands

### Sync manifest from cloud store

```bash
python3 <SKILL_DIR>/store-cli.py sync
```

Fetches the latest skill catalog (manifest) from the configured cloud store and caches
it locally. This is required before first use if the Gateway has not yet started.

### Search for skills

```bash
python3 <SKILL_DIR>/store-cli.py search <keyword>
```

Example:

```bash
python3 <SKILL_DIR>/store-cli.py search architecture
python3 <SKILL_DIR>/store-cli.py search testing
python3 <SKILL_DIR>/store-cli.py search diagram
```

Searches the local manifest cache by skill name. Returns matching skills with version
and publisher info.

### List all available skills

```bash
python3 <SKILL_DIR>/store-cli.py list
```

Shows every skill in the store catalog with version, publisher, and install status.

### List installed skills

```bash
python3 <SKILL_DIR>/store-cli.py list --installed
```

Shows only skills that are currently installed.

### Install a skill

```bash
python3 <SKILL_DIR>/store-cli.py install <name>
```

Example:

```bash
python3 <SKILL_DIR>/store-cli.py install ascii-diagram-creator
python3 <SKILL_DIR>/store-cli.py install architecture
python3 <SKILL_DIR>/store-cli.py install e2e-tests
```

Downloads the skill package (.tar.gz) from the store, verifies **every file** against
the manifest SHA256 hashes, checks the file count, and installs to the managed skills
directory (`~/.openclaw-dev/skills/` or `~/.openclaw/skills/`).

Use `--force` to reinstall an already installed skill.

The Gateway detects the new skill automatically on the next config reload or session.

### Show skill details

```bash
python3 <SKILL_DIR>/store-cli.py info <name>
```

Displays detailed information: version, publisher, verified status, file list with
SHA256 hashes, install status, and blocklist status.

### Update a skill

```bash
python3 <SKILL_DIR>/store-cli.py update <name>
python3 <SKILL_DIR>/store-cli.py update --all
```

Re-downloads and re-verifies the skill from the store. Use `--all` to update every
installed skill.

### Remove a skill

```bash
python3 <SKILL_DIR>/store-cli.py remove <name>
```

Removes the skill from the managed skills directory.

## API Endpoints

The store URL is read from `openclaw.json` → `skills.guard.trustedStores[0].url`.

Given a base URL like `http://store.example.com/api/v1/skill-guard`:

| Endpoint | Description |
|---|---|
| `{base}/manifest` | Full skill catalog with SHA256 hashes |
| `{base}/skills/{name}/download` | Download skill package (.tar.gz) |

## Notes

- `<SKILL_DIR>` refers to the directory containing this SKILL.md file.
  Resolve it from the absolute path of this file (its parent directory).
- The store URL is auto-discovered from `openclaw.json`
  (key: `skills.guard.trustedStores[0].url`).
- If the manifest cache is missing, `sync` is called automatically.
- Search is instant (uses locally cached manifest, no network needed).
- Install and update require network access to the store.
- All installs are SHA256-verified — tampered packages are rejected.
- Skills on the store blocklist cannot be installed.
- After installing or removing a skill, the Gateway picks up changes
  on the next config reload or session.
