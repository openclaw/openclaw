---
name: feishu-send-local-file
description: |
  Send local files from the filesystem to Feishu (Lark) chat for user download.
  Use when the user requests to upload, send, or share a local file to Feishu
  so they can download it on their device. Supports any file type including
  documents, images, archives, code files, etc.

  Trigger phrases include:
  - "把本地文件上传到飞书"
  - "发送文件到飞书"
  - "把文件传到飞书给我下载"
  - "upload this file to Feishu"
  - "send this file to Lark"
  - "share this file on Feishu"
---

# Feishu Send Local File

Send local files from the agent's filesystem to Feishu chat conversations for user download.

## When to Use This Skill

This skill is triggered when the user wants to transfer a file from the local machine
to their Feishu/Lark app for download. Common scenarios:

- User generated a report/document and wants it on their phone
- User needs to download a log file or configuration
- User wants to share a local file with colleagues via Feishu
- User needs to transfer files between local machine and mobile device

## Prerequisites

- File must exist on the local filesystem (verify with `read` or file tools)
- Feishu channel must be configured and active
- User must be in an active Feishu conversation (DM or group)

## Workflow

### 1. Verify File Exists

Before sending, confirm the file exists and is readable:

```
read: { "file_path": "/path/to/file" }
```

Or check file info:

```
exec: "ls -la /path/to/file"
```

### 2. Send File to Feishu

Use the `message` tool with `filePath` parameter:

```json
{
  "action": "send",
  "filePath": "/absolute/path/to/file",
  "filename": "display-name.pdf"
}
```

**Parameters:**

- `action`: `"send"` (required)
- `filePath`: Absolute path to the local file (required)
- `filename`: Display name shown in Feishu (optional, defaults to actual filename)

### 3. Confirm Delivery

The Feishu API will return a message ID if successful:

```json
{
  "channel": "feishu",
  "messageId": "om_xxxxx",
  "chatId": "ou_xxxxx"
}
```

Report success to the user with the filename.

## Error Handling

| Error             | Cause                          | Solution                            |
| ----------------- | ------------------------------ | ----------------------------------- |
| File not found    | Path incorrect or file deleted | Verify path with `ls`               |
| Permission denied | No read access                 | Check file permissions              |
| Upload failed     | Network or API error           | Retry once, then report error       |
| File too large    | Exceeds Feishu limits (>100MB) | Suggest alternative transfer method |

## Limitations

- **File size**: Feishu has upload limits (typically 100MB for regular files)
- **File types**: Most file types supported, but executable files may be blocked
- **Security**: Do not send sensitive files (passwords, keys) without encryption
- **Persistence**: Files are stored temporarily; user should download promptly

## Alternative Approaches

If file is too large or sending fails:

1. **Compress**: Create a ZIP archive before sending

   ```bash
   zip -r archive.zip /path/to/large-folder
   ```

2. **Cloud storage**: Use `feishu-drive` skill to upload to Feishu Drive instead

3. **External link**: Upload to cloud storage and share URL

## Examples

### Example 1: Send a document

```
User: "把 /Users/ppg/Downloads/report.pdf 上传到飞书"

Action: message send with filePath="/Users/ppg/Downloads/report.pdf"
```

### Example 2: Send with custom display name

```
User: "Send this log file to Feishu"

Action: message send with
  filePath="/var/log/app.log"
  filename="app-debug-2024-03-04.log"
```

### Example 3: Send after processing

```
User: "Generate and send the summary"

Steps:
1. Generate summary file
2. read to verify creation
3. message send with filePath
```

## Related Skills

- `feishu-doc`: For creating/editing Feishu documents
- `feishu-drive`: For cloud storage file management
- `feishu-wiki`: For knowledge base operations
