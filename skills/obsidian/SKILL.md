---
name: obsidian
description: Work with Obsidian vaults from the terminal using obs CLI (obsidian-vault-cli). 100+ commands for files, search, tags, properties, links, tasks, daily notes, templates, bookmarks, plugins, canvas, bases, themes, sync, and import.
homepage: https://github.com/markfive-proto/obsidian-vault-cli
metadata:
  {
    "openclaw":
      {
        "emoji": "💎",
        "requires": { "bins": ["obs"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "obsidian-vault-cli",
              "bins": ["obs"],
              "label": "Install obs (npm)",
            },
          ],
      },
  }
---

# Obsidian

Obsidian vault = a normal folder on disk.

Vault structure (typical)

- Notes: `*.md` (plain text Markdown; edit with any editor)
- Config: `.obsidian/` (workspace + plugin settings; usually do not touch from scripts)
- Canvases: `*.canvas` (JSON)
- Attachments: whatever folder you chose in Obsidian settings (images/PDFs/etc.)

## Find the active vault(s)

Obsidian desktop tracks vaults here (source of truth):

- `~/Library/Application Support/obsidian/obsidian.json`

`obs` resolves vaults from that file; vault name is typically the **folder name** (path suffix).

Fast "what vault is active / where are the notes?"

- Run `obs init` to auto-detect and configure your default vault
- Or manually: `obs vault config defaultVault /path/to/vault`

Notes

- Multiple vaults common (iCloud vs `~/Documents`, work/personal, etc.). Do not guess; read config.
- Avoid writing hardcoded vault paths into scripts; use `obs --vault /path` or configure a default.

## obs quick start

Pick a default vault (once):

- `obs init` (auto-detect from Obsidian's config)
- `obs vault config defaultVault /path/to/vault` (manual)
- `obs vault info` / `obs vault stats`

## Core commands

### Files

- `obs files list` — List all files (supports `--folder`, `--sort`, `--limit`, `--ext`)
- `obs files read path/to/note.md` — Print file content (`--head`, `--tail`)
- `obs files write path/to/note.md --content "..."` — Write to file
- `obs files create path/to/new.md` — Create new file (`--template`)
- `obs files delete path/to/note.md` — Delete file (`--force`)
- `obs files move old.md new.md` — Move/rename
- `obs files total` — Count of markdown files

### Search

- `obs search content "query"` — Full-text search (`--case-sensitive`, `--limit`)
- `obs search path "meeting"` — Glob filename search
- `obs search regex "TODO|FIXME"` — Regex search (`--flags`)

### Tags

- `obs tags list path/to/note.md` — Tags from frontmatter
- `obs tags add path/to/note.md project` — Add tag
- `obs tags remove path/to/note.md project` — Remove tag
- `obs tags all` — Vault-wide tag counts (`--sort`, `--min-count`)

### Properties (frontmatter)

- `obs properties read path/to/note.md` — All properties
- `obs properties read path/to/note.md title` — Specific property
- `obs properties set path/to/note.md status draft` — Set property

### Daily notes

- `obs daily create` — Create today's note (`--date`, `--template`)
- `obs daily open` — Print today's note (`--date`)
- `obs daily list` — Recent daily notes (`--limit`, `--days`)

### Tasks

- `obs tasks all` / `obs tasks pending` / `obs tasks done`
- `obs tasks add path/to/note.md "Buy groceries"`
- `obs tasks toggle path/to/note.md 15` — Toggle checkbox at line
- `obs tasks remove path/to/note.md 15`

### Links

- `obs links list path/to/note.md` — Outgoing links
- `obs links backlinks path/to/note.md` — Incoming links
- `obs links broken` — Unresolved wikilinks (`--limit`)

### Templates

- `obs templates list` — Available templates
- `obs templates apply "Meeting" Notes/standup.md`
- `obs templates create "Weekly Review"` (`--content`)

### Bookmarks

- `obs bookmarks list` / `obs bookmarks add` / `obs bookmarks remove`

### Plugins

- `obs plugins list` (`--enabled`, `--disabled`)
- `obs plugins versions` — Community plugin versions
- `obs plugins enable dataview` / `obs plugins disable dataview`

### Canvas

- `obs canvas list` / `obs canvas read` / `obs canvas create` (`--text`)
- `obs canvas nodes path/to/canvas.canvas`

### Bases

- `obs bases list` / `obs bases read` / `obs bases create` (`--source`)

### Themes

- `obs themes list` / `obs themes apply "Minimal"`

### Sync (git)

- `obs sync status` / `obs sync push` (`--message`) / `obs sync pull`

### Import

- `obs import url https://example.com/article` (`--name`)

### Dev tools

- `obs dev eval "vault.listFiles()"` — Eval JS with vault in scope
- `obs dev script ./my-script.js` — Run JS file with vault context

## Global options

Every command supports:

- `--vault <path>` — Override default vault
- `--json` — Machine-readable JSON output
- `--help` — Command help

## JSON mode

All commands support `--json`. Pipe to `jq`:

- `obs vault stats --json | jq '.fileCount'`
- `obs tasks pending --json | jq -r '.[] | [.file, .line, .text] | @csv'`
- `obs tags all --json | jq '.[0:5]'`
- `obs search content "TODO" --json | jq '[.[].file] | unique'`
