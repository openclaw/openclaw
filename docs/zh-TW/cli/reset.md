---
summary: "「openclaw reset」的 CLI 參考（重置本機狀態／設定）"
read_when:
  - 你想在保留 CLI 已安裝的情況下清除本機狀態
  - 你想進行乾跑（dry-run）以查看將會被移除的項目
title: "重置"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:22Z
---

# `openclaw reset`

重置本機設定／狀態（保留 CLI 已安裝）。

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
