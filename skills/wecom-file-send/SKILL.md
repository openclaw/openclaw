---
name: wecom-file-send
description: "Send files to WeCom (Enterprise WeChat) users via the app API. Activate when user asks to send files, documents, PDFs, Excel, images, or any attachment through WeCom/企业微信. Trigger words: 发文件, 发送文件, 企业微信发, 发给, 推送文件, send file, wecom file."
---

# WeCom File Send

Send files to WeCom users via the self-built app API (自建应用).

## Config

- **CorpID:** `ww7cb680a3906fd115`
- **AgentId:** `1000002`
- **Secret:** `fgxxFND5_b7z5FH6zREldwe1Ga69HElyvBtE9K32evE`
- **Trusted IP:** `58.209.39.234`

## Usage

Run the send script:

```bash
node ~/openclaw/skills/wecom-file-send/scripts/send-file.cjs <userId> <filePath> [message]
```

Parameters:

- `userId` — WeCom user ID (e.g., `WangPengCheng`, `WangChong`)
- `filePath` — Absolute path to the file
- `message` — Optional text message sent before the file

## Known User IDs

| 姓名   | userId        |
| ------ | ------------- |
| 王鹏程 | WangPengCheng |
| 王冲   | WangChong     |

## Workflow

1. Generate or locate the file to send
2. Run the send script with target userId and file path
3. Script handles: get access_token → upload file → send file message
4. Confirm delivery to user

## Supported File Types

PDF, Excel, Word, HTML, images, zip — any file up to 20MB.

## Notes

- Temporary media expires after 3 days
- If IP whitelist error (60020), check trusted IP config in WeCom admin
- For sending to multiple users, separate userIds with `|` (e.g., `UserA|UserB`)
- **重要：给其他人发送消息/文件时，注明文件来源（例如：「此文件来自王鹏程」或「王鹏程发送」）**
