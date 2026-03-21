---
name: apple-notes
description: Manage Apple Notes via the `memo` CLI on macOS (create, view, edit, delete, search, move, and export notes). Use when a user asks OpenClaw to add a note, list notes, search notes, or manage note folders.
homepage: https://github.com/jacob-bayer/memo
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "os": ["darwin"],
        "requires": { "bins": ["memo"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "jacob-bayer/tap/memo",
              "bins": ["memo"],
              "label": "Install memo via Homebrew",
            },
          ],
      },
  }
---

# Apple Notes CLI

Use `memo notes` to manage Apple Notes directly from the terminal. Create, view, edit, delete, search, move notes between folders, and export to HTML/Markdown.

Setup

- Install (Homebrew): `brew tap jacob-bayer/tap && brew install jacob-bayer/tap/memo`
- Manual (pip): `pip install .` (after cloning the repo)
- macOS-only; if prompted, grant Automation access to Notes.app.

View Notes

- List all notes: `memo notes`
- Filter by folder: `memo notes -f "Folder Name"`
- Search notes (fuzzy): `memo notes -s "query"`

Create Notes

- Add a new note: `memo notes -a`
  - Opens an interactive editor to compose the note.
- Quick add with title: `memo notes -a "Note Title"`

Edit Notes

- Edit existing note: `memo notes -e`
  - Interactive selection of note to edit.

Delete Notes

- Delete a note: `memo notes -d`
  - Interactive selection of note to delete.

Move Notes

- Move note to folder: `memo notes -m`
  - Interactive selection of note and destination folder.

Export Notes

- Export to HTML/Markdown: `memo notes -ex`
  - Exports selected note; uses Mistune for markdown processing.

Non-Interactive API (for agents and scripts)

Use `memo notes api <subcommand>` for scripting and agent workflows. All commands are non-interactive and machine-readable.

- List notes: `memo notes api list [--folder FOLDER] [--format tsv|json|lines]`
- Show note body (Markdown): `memo notes api show <note-id>`
- Edit note from stdin: `echo "# Updated content" | memo notes api edit <note-id>`
- Add note from stdin: `echo "# New note" | memo notes api add --folder "Folder Name"`
- Delete note: `memo notes api delete <note-id>`
- Move note: `memo notes api move <note-id> <target-folder>`
- List folders: `memo notes api folders [--format tsv|json]`
- Search notes: `memo notes api search <query> [--folder FOLDER] [--format tsv|json] [--body]`
- Remove folder: `memo notes api remove <folder-name> --force`
- Export notes: `memo notes api export --path /path/to/dir [--markdown]`

Limitations

- Cannot edit notes containing images or attachments via the API.
- Interactive prompts require terminal access (use `api` subcommands for automation).

Notes

- macOS-only.
- Requires Apple Notes.app to be accessible.
- For automation, grant permissions in System Settings > Privacy & Security > Automation.
