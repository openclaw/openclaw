---
summary: "CLI 參考文件：`openclaw memory` (狀態/索引/搜尋)"
read_when:
  - 您希望為語義記憶建立索引或進行搜尋
  - 您正在偵錯記憶體可用性或索引功能
title: "記憶體"
---

# `openclaw memory`

管理語義記憶體索引和搜尋。
由活躍的記憶體外掛程式提供（預設：`memory-core`；設定 `plugins.slots.memory = "none"` 可停用）。

相關：

- 記憶體概念：[記憶體](/concepts/memory)
- 外掛程式：[外掛程式](/tools/plugin)

## 範例

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## 選項

通用：

- `--agent <id>`: 限制為單一智慧代理（預設：所有已設定的智慧代理）。
- `--verbose`: 在探測和索引期間發出詳細記錄。

注意事項：

- `memory status --deep` 探測向量 + 嵌入的可用性。
- `memory status --deep --index` 如果儲存庫有變更，則執行重新索引。
- `memory index --verbose` 列印每個階段的詳細資訊（供應商、模型、來源、批次活動）。
- `memory status` 包含透過 `memorySearch.extraPaths` 設定的任何額外路徑。
