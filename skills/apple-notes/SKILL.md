---
name: apple-notes
description: Create, view, edit, delete, search, move, or export Apple Notes via the memo CLI on macOS.
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

Limitations

- Cannot edit notes containing images or attachments.
- Interactive prompts may require terminal access.

Notes

- macOS-only.
- Requires Apple Notes.app to be accessible.
- For automation, grant permissions in System Settings > Privacy & Security > Automation.

## Native Alternative (No `memo` dependency)

If you want a lower-friction setup that doesn't require installing the `memo` CLI, you can find native macOS AppleScript-based skills on ClawHub.

**Search and Install:**

```bash
openclaw skills search apple-notes
openclaw skills install apple-notes-native
```

Benefits of native-first alternatives:

- No third-party binary dependencies (no `memo` brew tap needed).
- Direct interaction with Notes.app via official automation APIs.
- Simpler setup for macOS-only environments.

**Caveats:**

- **Automation Permissions:** Requires "Automation" access for Notes.app in macOS System Settings.
- **Reliability:** AppleScript (osascript) can occasionally be slower than direct binary access.
- **UI Context:** Notes.app may need to be open or in a specific state for some operations.
