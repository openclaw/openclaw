---
name: obsidian
description: Work with Obsidian vaults (plain Markdown notes) and automate via the official Obsidian CLI.
homepage: https://help.obsidian.md
metadata:
  {
    "openclaw":
      {
        "emoji": "💎",
        "requires": { "bins": ["obsidian"] },
      },
  }
---

# Obsidian

Obsidian vault = a normal folder on disk.

Vault structure (typical)

- Notes: `*.md` (plain Markdown; edit with any editor)
- Config: `.obsidian/` (workspace + plugin settings)
- Canvases: `*.canvas` (JSON)
- Attachments: folder chosen in Obsidian settings

## Installing the official CLI

The `obsidian` binary is registered from within the app — it is **not** available via brew or npm.

**One-time setup:** Open Obsidian → Settings → Command-line interface → Register  
This creates a symlink at `/usr/local/bin/obsidian` (requires sudo via system dialog).

> **Key constraint: Obsidian must be running.** The CLI communicates with the live app via IPC. Commands will fail in headless/CI environments where Obsidian is not open. This is the primary gotcha to surface to users.

## Vault discovery

```bash
obsidian vaults                 # list all known vaults (name + path)
obsidian vault                  # show active vault info
obsidian vault info=path        # return just the path
```

Fallback: Obsidian tracks vaults in `~/Library/Application Support/obsidian/obsidian.json` — the entry with `"open": true` is the active vault.

**Per-command vault targeting:** use `vault=<name>` to target a specific vault on any command.  
There is no persistent default — pass `vault=` each time when working outside the active vault.

Multiple vaults are common (iCloud vs `~/Documents`, work/personal, etc.). Don't hardcode paths; use `obsidian vault` or parse the config file.

## Argument style

- `file=<name>` — resolves by name like a wikilink (fuzzy, no path needed)
- `path=<folder/note.md>` — exact relative path from vault root
- Most commands default to the **active file** when `file`/`path` is omitted
- Quote values with spaces: `name="My Note"`, `content="line one\nline two"`
- Use `\n` for newline, `\t` for tab in content values

## Command cheat sheet

### Discovery

```bash
obsidian vaults                              # list all known vaults
obsidian vault                               # active vault name, path, stats
obsidian files                               # list all files in vault
obsidian folders                             # list all folders
obsidian recents                             # recently opened files
```

### Read

```bash
obsidian read file="My Note"                 # read note by name
obsidian read path="Projects/note.md"        # read note by exact path
obsidian outline file="My Note"              # heading outline
obsidian properties file="My Note"           # all frontmatter properties
obsidian property:read file="My Note" name=status  # single property value
```

### Search

```bash
obsidian search query="project alpha"        # files matching query
obsidian search query="TODO" path="Work"     # scoped to folder
obsidian search:context query="decision"     # search with matching line snippets
obsidian search query="x" total             # return match count only
```

### Write

```bash
obsidian create name="New Note" content="# Title\nBody text"
obsidian create name="New Note" template="Daily" open
obsidian append file="My Note" content="New line"
obsidian prepend file="My Note" content="Inserted at top"
obsidian property:set file="My Note" name=status value=done
```

### Refactor (wikilink-safe)

```bash
obsidian rename file="Old Name" name="New Name"   # updates all wikilinks
obsidian move path="old/note.md" path="new/note.md"  # updates all wikilinks
obsidian delete file="Draft Note"
```

Rename/move go through Obsidian itself, so `[[wikilinks]]` across the vault are updated automatically — use these over `mv`/`cp`.

### Links & structure

```bash
obsidian backlinks file="My Note"            # notes linking to this note
obsidian links file="My Note"               # links from this note
obsidian tags                               # all tags in vault (with counts)
obsidian tags file="My Note"               # tags in a specific note
obsidian aliases file="My Note"            # aliases defined in frontmatter
obsidian orphans                           # notes with no incoming links
obsidian unresolved                        # broken/unresolved wikilinks
```

### Daily notes

```bash
obsidian daily                             # open today's daily note
obsidian daily:read                        # read today's daily note
obsidian daily:append content="- [ ] Task" # append to today's daily note
obsidian daily:prepend content="# Morning" # prepend to today's daily note
obsidian daily:path                        # get path of today's daily note
```

### Plugins & themes

```bash
obsidian plugins                           # list installed plugins
obsidian plugin:enable name="dataview"     # enable a plugin
obsidian plugin:disable name="dataview"    # disable a plugin
obsidian themes                            # list installed themes
obsidian theme:set name="Minimal"          # activate a theme
```

### Open in UI

```bash
obsidian open file="My Note"              # open note in Obsidian
obsidian tab:open file="My Note"          # open in a new tab
```

### Tasks

```bash
obsidian tasks                            # list all tasks in vault
obsidian tasks todo                       # incomplete tasks only
obsidian tasks done                       # completed tasks only
obsidian tasks file="My Note" verbose     # tasks grouped by file with line numbers
obsidian task ref="Projects/note.md:12" toggle  # toggle task at line 12
```

## Output formats

Many commands support `format=json|tsv|csv`. Use `format=json` when piping to scripts. Use `total` flag for count-only responses.

## Prefer direct edits for bulk writes

For bulk content changes, editing the `.md` file directly is faster than repeated `append`/`prepend` calls. Obsidian picks up file-system changes automatically. Reserve the CLI for operations that benefit from Obsidian's awareness: rename, move, search, backlinks, properties.
