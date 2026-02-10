---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: obsidian（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Work with Obsidian vaults (plain Markdown notes) and automate via obsidian-cli.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://help.obsidian.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "💎",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["obsidian-cli"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "yakitrak/yakitrak/obsidian-cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["obsidian-cli"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install obsidian-cli (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Obsidian（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Obsidian vault = a normal folder on disk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Vault structure (typical)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Notes: `*.md` (plain text Markdown; edit with any editor)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: `.obsidian/` (workspace + plugin settings; usually don’t touch from scripts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Canvases: `*.canvas` (JSON)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Attachments: whatever folder you chose in Obsidian settings (images/PDFs/etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Find the active vault(s)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Obsidian desktop tracks vaults here (source of truth):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/Library/Application Support/obsidian/obsidian.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`obsidian-cli` resolves vaults from that file; vault name is typically the **folder name** (path suffix).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fast “what vault is active / where are the notes?”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you’ve already set a default: `obsidian-cli print-default --path-only`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Otherwise, read `~/Library/Application Support/obsidian/obsidian.json` and use the vault entry with `"open": true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multiple vaults common (iCloud vs `~/Documents`, work/personal, etc.). Don’t guess; read config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid writing hardcoded vault paths into scripts; prefer reading the config or using `print-default`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## obsidian-cli quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pick a default vault (once):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `obsidian-cli set-default "<vault-folder-name>"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `obsidian-cli print-default` / `obsidian-cli print-default --path-only`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `obsidian-cli search "query"` (note names)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `obsidian-cli search-content "query"` (inside notes; shows snippets + lines)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `obsidian-cli create "Folder/New note" --content "..." --open`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires Obsidian URI handler (`obsidian://…`) working (Obsidian installed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid creating notes under “hidden” dot-folders (e.g. `.something/...`) via URI; Obsidian may refuse.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Move/rename (safe refactor)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `obsidian-cli move "old/path/note" "new/path/note"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Updates `[[wikilinks]]` and common Markdown links across the vault (this is the main win vs `mv`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Delete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `obsidian-cli delete "path/note"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prefer direct edits when appropriate: open the `.md` file and change it; Obsidian will pick it up.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
