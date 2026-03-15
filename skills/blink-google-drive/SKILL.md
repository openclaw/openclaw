---
name: blink-google-drive
description: >
  List, search, read, upload, and manage files in Google Drive. Find documents,
  check recent files, share files, create folders. Use when asked to find or
  manage files in the user's Google Drive.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "google_drive" } }
---

# Blink Google Drive

Access the user's Google Drive. Provider key: `google_drive`.

## List recent files
```bash
bash scripts/call.sh google_drive /files GET \
  '{"pageSize": 20, "orderBy": "modifiedTime desc", "fields": "files(id,name,mimeType,modifiedTime,webViewLink)"}'
```

## Search for files
```bash
bash scripts/call.sh google_drive /files GET \
  '{"q": "name contains '\''report'\'' and trashed = false", "fields": "files(id,name,mimeType,webViewLink)"}'
```

## Get file metadata
```bash
bash scripts/call.sh google_drive /files/FILE_ID GET \
  '{"fields": "id,name,mimeType,description,createdTime,modifiedTime,owners,webViewLink"}'
```

## List files in a folder
```bash
bash scripts/call.sh google_drive /files GET \
  '{"q": "'\''FOLDER_ID'\'' in parents and trashed = false", "fields": "files(id,name,mimeType)"}'
```

## Create a folder
```bash
bash scripts/call.sh google_drive /files POST '{
  "name": "New Folder",
  "mimeType": "application/vnd.google-apps.folder"
}'
```

## Move a file to a folder
```bash
bash scripts/call.sh google_drive /files/FILE_ID PATCH '{"parents": ["FOLDER_ID"]}'
```

## Common use cases
- "Find the Q1 report in my Drive" → search by name
- "What files did I modify recently?" → list by modifiedTime desc
- "List everything in my Projects folder" → list with folder parent query
- "Create a folder called Client Work" → create folder
- "Give me a link to the design doc" → search + return webViewLink
