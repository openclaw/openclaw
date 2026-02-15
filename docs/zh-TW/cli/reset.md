```
---
summary: "openclaw reset 的 CLI 參考 (重設本地狀態/設定)"
read_when:
  - 您想清除本地狀態但保留 CLI 安裝
  - 您想模擬執行將會移除的內容
title: "reset"
---

# `openclaw reset`

重設本地設定/狀態 (保留 CLI 安裝)。

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
```
