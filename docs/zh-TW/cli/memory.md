---
summary: CLI reference for `openclaw memory` (status/index/search)
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
title: memory
---

# `openclaw memory`

管理語意記憶的索引與搜尋。
由主動記憶插件提供（預設為 `memory-core`；設定 `plugins.slots.memory = "none"` 可停用）。

相關：

- 記憶概念：[記憶](/concepts/memory)
- 插件：[插件](/tools/plugin)

## 範例

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory index --force
openclaw memory search "meeting notes"
openclaw memory search --query "deployment" --max-results 20
openclaw memory status --json
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## 選項

`memory status` 和 `memory index`：

- `--agent <id>`：限定於單一代理。若未指定，這些指令會對每個已設定的代理執行；若沒有設定代理清單，則會回退使用預設代理。
- `--verbose`：在探測和索引過程中輸出詳細日誌。

`memory status`:

- `--deep`: 探針向量 + 嵌入可用性。
- `--index`: 如果儲存區髒污則執行重新索引（暗示 `--deep`）。
- `--json`: 輸出 JSON 格式。

`memory index`:

- `--force`: 強制執行完整重新索引。

`memory search`:

- 查詢輸入：傳入位置參數 `[query]` 或 `--query <text>`。
- 若兩者皆提供，`--query` 優先。
- 若兩者皆未提供，指令將以錯誤結束。
- `--agent <id>`: 限定單一代理範圍（預設：預設代理）。
- `--max-results <n>`: 限制回傳結果數量。
- `--min-score <n>`: 過濾低分匹配項。
- `--json`: 輸出 JSON 結果。

備註：

- `memory index --verbose` 會列印每個階段的詳細資訊（提供者、模型、來源、批次活動）。
- `memory status` 包含透過 `memorySearch.extraPaths` 設定的任何額外路徑。
- 如果有效啟用的記憶體遠端 API 金鑰欄位是以 SecretRefs 設定，該指令會從啟用中的 gateway 快照解析這些值。若 gateway 無法使用，指令會快速失敗。
- Gateway 版本差異說明：此指令路徑需要支援 `secrets.resolve` 的 gateway；舊版 gateway 會回傳 unknown-method 錯誤。
