---
name: apple-notes
description: "Create, view, edit, delete, search, move, or export Apple Notes via the memo CLI on macOS."
homepage: https://github.com/antoniorodr/memo
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
              "formula": "antoniorodr/memo/memo",
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

- Install (Homebrew): `brew tap antoniorodr/memo && brew install antoniorodr/memo/memo`
- Manual (pip): `pip install .` (after cloning the repo)
- macOS-only; if prompted, grant Automation access to Notes.app.

View Notes

- List all notes: `memo notes`
- Refresh the inventory without the five-minute cache: `memo notes -nc`
- Filter by folder: `memo notes -f "Folder Name"`
- Read note N from the current inventory: `memo notes -v N`
- Search notes (interactive fuzzy selector): `memo notes -s`
  - `-s` is a boolean flag; enter the query in the selector.

Create Notes

- Add a new note to an existing folder: `memo notes -a -f "Folder Name"`
  - Opens an interactive editor to compose the note.
  - `-a` is a boolean flag; enter the title and body in the editor.

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
  - Interactively exports the default account or a chosen folder to HTML, with optional html2text Markdown conversion.

Limitations

- Cannot edit notes containing images or attachments.
- Interactive prompts may require terminal access.
- Search uses fzf; body previews require bat, which the Memo 0.6.0 Homebrew formula does not declare.
- Memo enumerates note IDs and titles before filtering by folder. Interactive search also reads note bodies into temporary files.
- These commands were checked against Memo 0.6.0; inspect `memo notes --help` for the installed version.

Notes

- macOS-only.
- Requires Apple Notes.app to be accessible.
- For automation, grant permissions in System Settings > Privacy & Security > Automation.
