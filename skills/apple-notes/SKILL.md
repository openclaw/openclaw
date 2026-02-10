---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: apple-notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Manage Apple Notes via the `memo` CLI on macOS (create, view, edit, delete, search, move, and export notes). Use when a user asks OpenClaw to add a note, list notes, search notes, or manage note folders.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://github.com/antoniorodr/memo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "📝",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "os": ["darwin"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["memo"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "antoniorodr/memo/memo",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["memo"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install memo via Homebrew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Apple Notes CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `memo notes` to manage Apple Notes directly from the terminal. Create, view, edit, delete, search, move notes between folders, and export to HTML/Markdown.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install (Homebrew): `brew tap antoniorodr/memo && brew install antoniorodr/memo/memo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Manual (pip): `pip install .` (after cloning the repo)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS-only; if prompted, grant Automation access to Notes.app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
View Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- List all notes: `memo notes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Filter by folder: `memo notes -f "Folder Name"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Search notes (fuzzy): `memo notes -s "query"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add a new note: `memo notes -a`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Opens an interactive editor to compose the note.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Quick add with title: `memo notes -a "Note Title"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Edit Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Edit existing note: `memo notes -e`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Interactive selection of note to edit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Delete Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Delete a note: `memo notes -d`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Interactive selection of note to delete.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Move Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Move note to folder: `memo notes -m`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Interactive selection of note and destination folder.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Export Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Export to HTML/Markdown: `memo notes -ex`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Exports selected note; uses Mistune for markdown processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Limitations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cannot edit notes containing images or attachments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Interactive prompts may require terminal access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS-only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires Apple Notes.app to be accessible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For automation, grant permissions in System Settings > Privacy & Security > Automation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
