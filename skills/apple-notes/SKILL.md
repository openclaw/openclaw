---
name: apple-notes
description: Manage Apple Notes via the `simple-memo` CLI on macOS (create, view, edit, delete, search, move, and export notes). Use when a user asks OpenClaw to add a note, list notes, search notes, or manage note folders.
homepage: https://github.com/inkolin/simple-memo
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "os": ["darwin"],
        "requires": { "bins": ["simple-memo"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "inkolin/tap/simple-memo",
              "bins": ["simple-memo"],
              "label": "Install simple-memo via Homebrew",
            },
          ],
      },
  }
---

# Apple Notes CLI

Use `simple-memo notes` to manage Apple Notes directly from the terminal. Create, view, edit, delete, search, move notes between folders, and export to HTML/Markdown.

Setup

- Install (Homebrew): `brew install inkolin/tap/simple-memo`
- Manual (pip): `pip install simple-memo`
- macOS-only; if prompted, grant Automation access to Notes.app.

View Notes

- List all notes: `simple-memo notes`
- Filter by folder: `simple-memo notes -f "Folder Name"`
- Search notes (fuzzy): `simple-memo notes -s "query"`

Create Notes

- Add a new note: `simple-memo notes -a`
  - Opens an interactive editor to compose the note.
- Quick add with title: `simple-memo notes -a "Note Title"`

Edit Notes

- Edit existing note: `simple-memo notes -e`
  - Interactive selection of note to edit.

Delete Notes

- Delete a note: `simple-memo notes -d`
  - Interactive selection of note to delete.

Move Notes

- Move note to folder: `simple-memo notes -m`
  - Interactive selection of note and destination folder.

Export Notes

- Export to HTML/Markdown: `simple-memo notes -ex`
  - Exports selected note; uses Mistune for markdown processing.

Limitations

- Cannot edit notes containing images or attachments.
- Interactive prompts may require terminal access.

Notes

- macOS-only.
- Requires Apple Notes.app to be accessible.
- For automation, grant permissions in System Settings > Privacy & Security > Automation.
