---
summary: "「openclaw logs」的 CLI 參考（透過 RPC 追蹤 Gateway 閘道器 記錄）"
read_when:
  - 您需要在不使用 SSH 的情況下，遠端追蹤 Gateway 閘道器 記錄
  - 您需要用於工具整合的 JSON 記錄行
title: "logs"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:25Z
---

# `openclaw logs`

透過 RPC 追蹤 Gateway 閘道器 檔案記錄（可在遠端模式下運作）。

相關：

- 記錄概覽：[Logging](/logging)

## 範例

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
