---
name: feishu-drive
description: |
  Feishu cloud storage file management. Activate when user mentions cloud space, folders, drive.
---

# Feishu Drive Tool

Single tool `feishu_drive` for cloud storage operations.

## Token Extraction

From URL `https://xxx.feishu.cn/drive/folder/ABC123` → `folder_token` = `ABC123`

## Actions

### List Folder Contents

```json
{ "action": "list" }
```

Root directory (no folder_token).

```json
{ "action": "list", "folder_token": "fldcnXXX" }
```

Returns: files with token, name, type, url, timestamps.

### Get File Info

```json
{ "action": "info", "file_token": "ABC123", "type": "docx" }
```

Searches for the file in the root directory. Note: file must be in root or use `list` to browse folders first.

`type`: `doc`, `docx`, `sheet`, `bitable`, `folder`, `file`, `mindnote`, `shortcut`

### Create Folder

```json
{ "action": "create_folder", "name": "New Folder" }
```

In parent folder:

```json
{ "action": "create_folder", "name": "New Folder", "folder_token": "fldcnXXX" }
```

### Move File

```json
{ "action": "move", "file_token": "ABC123", "type": "docx", "folder_token": "fldcnXXX" }
```

### Delete File

```json
{ "action": "delete", "file_token": "ABC123", "type": "docx" }
```

## Comment Strategy

When using `feishu_drive` for document comments, choose the narrowest comment scope that matches the feedback.

- Prefer **local comments** over whole-document comments when the feedback points to a specific paragraph, sentence, block, or nearby issue.
- In review scenarios, do **not** collect many concrete findings into one whole-document comment if those findings can be anchored separately.
- If there are multiple distinct problems in different places, create multiple local comments instead of one aggregated whole-document comment.
- Use **reply_comment** when continuing an existing comment card. Do not open a new whole-document comment unless the user explicitly wants a new top-level summary.
- Reserve **whole-document comments** for cross-cutting feedback, overall summaries, or cases where no stable local anchor exists.

### Review Guidance

- Line edit / wording / factual issue near a specific block: prefer a local comment.
- One section has several tightly related issues: one local comment on that section is fine.
- Many unrelated findings across the document: split into multiple local comments.
- Final overall review summary: whole-document comment is acceptable only after the local findings are already anchored, or when the user explicitly asks for a single top-level summary.

### Local vs Whole Comment

- Local comment: `add_comment` with `block_id`
- Whole-document comment: `add_comment` without `block_id`
- Reply in existing thread: `reply_comment`

### Important Scope Boundary

- `feishu_drive.add_comment` local comments require `block_id`, and that anchor path is only available for `docx`.
- For non-`docx` file types, do not pretend a local anchor exists if the tool cannot target one.

## File Types

| Type       | Description             |
| ---------- | ----------------------- |
| `doc`      | Old format document     |
| `docx`     | New format document     |
| `sheet`    | Spreadsheet             |
| `bitable`  | Multi-dimensional table |
| `folder`   | Folder                  |
| `file`     | Uploaded file           |
| `mindnote` | Mind map                |
| `shortcut` | Shortcut                |

## Configuration

```yaml
channels:
  feishu:
    tools:
      drive: true # default: true
```

## Permissions

- `drive:drive` - Full access (create, move, delete)
- `drive:drive:readonly` - Read only (list, info)

## Known Limitations

- **Bots have no root folder**: Feishu bots use `tenant_access_token` and don't have their own "My Space". The root folder concept only exists for user accounts. This means:
  - `create_folder` without `folder_token` will fail (400 error)
  - Bot can only access files/folders that have been **shared with it**
  - **Workaround**: User must first create a folder manually and share it with the bot, then bot can create subfolders inside it
