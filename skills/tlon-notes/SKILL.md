---
name: tlon-notes
description: Read and write Tlon %notes notebooks from OpenClaw/Tlonbot agents. Use for listing notebooks/folders/notes; creating notebooks, folders, notes; updating/moving notes; batch importing; and working with arthyn/notes v0 flag-based APIs or legacy numeric %notes APIs.
metadata: { "openclaw": { "emoji": "🗒️", "requires": { "bins": ["node"] } } }
---

# Tlon Notes

Use this skill when an agent needs to operate on Tlon `%notes` notebooks.

Prefer the bundled client script instead of hand-writing Eyre pokes:

```bash
{baseDir}/scripts/notes-client.js --ship ~malmur-halmex list-notebooks
```

The script supports current `arthyn/notes` v0 flag-based APIs and older numeric notebook APIs.

## Auth

The client reads auth in this order:

- CLI flags: `--url`, `--ship`, `--cookie`, `--code`
- env: `URBIT_URL`/`SHIP_URL`, `URBIT_SHIP`/`SHIP_NAME`, `URBIT_COOKIE`/`SHIP_COOKIE`, `URBIT_CODE`/`SHIP_CODE`
- Tlon CLI cache: `~/.tlon/cache/<ship>.json`

Use `--ship ~ship` when multiple ships are cached.

## Safe workflow

1. Read first: `list-notebooks`, then `list-folders <notebook>`, then `list-notes <notebook>`.
2. Resolve the root folder id before creating/moving notes.
3. For writes, run without `--apply` first; it prints the exact JSON poke as a dry run.
4. Only add `--apply` after confirming the target notebook/folder and action.
5. Verify by reading folders/notes again.

Notebook refs may be full v0 flags (`~host/wiki-5`), flag names (`wiki-5`), titles (`Wiki`), or numeric ids for legacy notebooks.

## Commands

```bash
# Read
{baseDir}/scripts/notes-client.js [auth] list-notebooks
{baseDir}/scripts/notes-client.js [auth] list-folders <notebook-ref>
{baseDir}/scripts/notes-client.js [auth] list-notes <notebook-ref>

# Write: dry-run by default; add --apply to mutate live %notes
{baseDir}/scripts/notes-client.js [auth] create-notebook "Notebook Title" [--apply]
{baseDir}/scripts/notes-client.js [auth] create-folder <notebook-ref> <parent-folder-id> "Folder Name" [--apply]
{baseDir}/scripts/notes-client.js [auth] create-note <notebook-ref> <folder-id> "Title" <body-file|-> [--apply]
{baseDir}/scripts/notes-client.js [auth] update-note <notebook-ref> <note-id> <expected-revision> <body-file|-> [--apply]
{baseDir}/scripts/notes-client.js [auth] move-note <notebook-ref> <note-id> <folder-id> [--apply]
{baseDir}/scripts/notes-client.js [auth] batch-import <notebook-ref> <folder-id> <notes-json-file> [--apply]
```

`batch-import` JSON should be an array like:

```json
[{ "title": "Note title", "body": "Markdown body" }]
```

## Current v0 action shapes

Reads use authenticated scries:

```text
/~/scry/notes/v0/notebooks.json
/~/scry/notes/v0/folders/~host/flag-name.json
/~/scry/notes/v0/notes/~host/flag-name.json
```

Writes are Eyre/Airlock pokes to `%notes` with mark `%notes-action`:

```json
{
  "type": "notebook",
  "flag": "~malmur-halmex/wiki-5",
  "action": {
    "type": "create-note",
    "folder": 6,
    "title": "Title",
    "body": "Markdown body"
  }
}
```

Other v0 actions:

```json
{"type":"create-notebook","title":"Sources"}
{"type":"notebook","flag":"~host/wiki-5","action":{"type":"create-folder","parent":6,"name":"Topic"}}
{"type":"notebook","flag":"~host/wiki-5","action":{"type":"note","id":14,"action":{"type":"update","body":"...","expectedRevision":0}}}
{"type":"notebook","flag":"~host/wiki-5","action":{"type":"note","id":14,"action":{"type":"move","folder":158}}}
{"type":"notebook","flag":"~host/wiki-5","action":{"type":"batch-import","folder":6,"notes":[{"title":"T","body":"B"}]}}
```

For v0 folders, prefer creating topic folders with the root folder id as `parent`; null-parent folders may not appear under `/` in the UI.

## Safety notes

- Do not expose ship codes or cookies.
- For destructive or large live changes, ask first and/or produce a dry-run plan.
- Preserve note IDs by moving/updating existing notes; `create-note` and `batch-import` allocate new ids.
- Use `expectedRevision` when updating notes to avoid clobbering concurrent edits.
