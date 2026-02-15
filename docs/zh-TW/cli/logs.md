---
summary: "openclaw logs 的 CLI 參考文件（透過 RPC 監控 Gateway 記錄）"
read_when:
  - 您需要遠端監控 Gateway 記錄（不需使用 SSH）
  - 您需要 JSON 格式的記錄內容以供工具使用
title: "logs"
---

# `openclaw logs`

透過 RPC 監控 Gateway 檔案記錄（可在遠端模式下運作）。

相關：

- 記錄總覽：[Logging](/logging)

## 範例

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
```

使用 `--local-time` 以您的本地時區呈現時間戳記。
