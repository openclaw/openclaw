---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: feishu-drive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Feishu cloud storage file management. Activate when user mentions cloud space, folders, drive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Feishu Drive Tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Single tool `feishu_drive` for cloud storage operations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Token Extraction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From URL `https://xxx.feishu.cn/drive/folder/ABC123` → `folder_token` = `ABC123`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### List Folder Contents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "action": "list" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Root directory (no folder_token).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "action": "list", "folder_token": "fldcnXXX" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Returns: files with token, name, type, url, timestamps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Get File Info（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "action": "info", "file_token": "ABC123", "type": "docx" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Searches for the file in the root directory. Note: file must be in root or use `list` to browse folders first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`type`: `doc`, `docx`, `sheet`, `bitable`, `folder`, `file`, `mindnote`, `shortcut`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Create Folder（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "action": "create_folder", "name": "New Folder" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In parent folder:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "action": "create_folder", "name": "New Folder", "folder_token": "fldcnXXX" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Move File（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "action": "move", "file_token": "ABC123", "type": "docx", "folder_token": "fldcnXXX" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Delete File（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "action": "delete", "file_token": "ABC123", "type": "docx" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## File Types（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Type       | Description             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ----------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `doc`      | Old format document     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `docx`     | New format document     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `sheet`    | Spreadsheet             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `bitable`  | Multi-dimensional table |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `folder`   | Folder                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `file`     | Uploaded file           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `mindnote` | Mind map                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `shortcut` | Shortcut                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```yaml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
channels:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  feishu:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      drive: true # default: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `drive:drive` - Full access (create, move, delete)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `drive:drive:readonly` - Read only (list, info)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Known Limitations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Bots have no root folder**: Feishu bots use `tenant_access_token` and don't have their own "My Space". The root folder concept only exists for user accounts. This means:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `create_folder` without `folder_token` will fail (400 error)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Bot can only access files/folders that have been **shared with it**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Workaround**: User must first create a folder manually and share it with the bot, then bot can create subfolders inside it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
