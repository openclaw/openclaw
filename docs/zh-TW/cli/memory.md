---
summary: "CLI 參考文件：`openclaw memory`（status/index/search）"
read_when:
  - 您想要建立索引或搜尋語意記憶
  - 您正在除錯記憶可用性或索引建立
title: "memory"
---

# `openclaw memory`

Manage semantic memory indexing and search.
管理語意記憶的索引與搜尋。
由目前啟用的記憶體外掛提供（預設：`memory-core`；可設定 `plugins.slots.memory = "none"` 以停用）。

Related:

- 記憶概念：[Memory](/concepts/memory)
- 外掛：[Plugins](/tools/plugin)

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

- `--agent <id>`：將範圍限定為單一代理程式（預設：所有已設定的代理程式）。
- `--verbose`：在探測與索引建立期間輸出詳細記錄。

注意事項：

- `memory status --deep`：探測向量與嵌入可用性。
- `memory status --deep --index`：如果儲存區為髒狀態，則執行重新索引。
- `memory index --verbose`：列印各階段的詳細資訊（提供者、模型、來源、批次活動）。
- `memory status`：包含任何透過 `memorySearch.extraPaths` 設定的額外路徑。
