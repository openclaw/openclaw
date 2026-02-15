---
summary: "openclaw memory 的 CLI 參考文件（狀態/索引/搜尋）"
read_when:
  - 當您想要索引或搜尋語義記憶時
  - 當您在偵錯記憶體可用性或索引功能時
title: "memory"
---

# `openclaw memory`

管理語義記憶的索引與搜尋。
由作用中的記憶體外掛程式提供（預設：`memory-core`；將 `plugins.slots.memory = "none"` 即可停用）。

相關內容：

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

常用：

- `--agent <id>`：限定範圍於單一智慧代理（預設：所有已設定的智慧代理）。
- `--verbose`：在探測與索引期間輸出詳細紀錄。

說明：

- `memory status --deep` 探測向量（vector）與 embedding 的可用性。
- `memory status --deep --index` 若儲存空間有變動（dirty），則執行重新索引。
- `memory index --verbose` 會印出各階段的詳細資訊（供應商、模型、來源、批次活動）。
- `memory status` 包含透過 `memorySearch.extraPaths` 設定的任何額外路徑。
