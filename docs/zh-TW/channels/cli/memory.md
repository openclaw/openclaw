---
summary: CLI reference for `openclaw memory` (status/index/search)
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
title: memory
---

# `openclaw memory`

管理語意記憶索引和搜尋。  
由主動記憶插件提供（預設：`memory-core`；設定 `plugins.slots.memory = "none"` 以禁用）。

[[BLOCK_1]]

- 記憶體概念: [Memory](/concepts/memory)
- 外掛: [Plugins](/tools/plugin)

## Examples

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

## Options

`memory status` and `memory index`:

- `--agent <id>`: 限定為單一代理。若未設定，這些指令將針對每個已設定的代理執行；如果沒有設定代理列表，則會回退到預設代理。
- `--verbose`: 在探測和索引過程中發出詳細日誌。

`memory status`:

- `--deep`: 探測向量 + 嵌入可用性。
- `--index`: 如果儲存區不乾淨則執行重新索引（這意味著 `--deep`）。
- `--json`: 輸出 JSON 格式。

`memory index`:

- `--force`: 強制進行完整重建索引。

`memory search`:

- 查詢輸入：傳遞位置參數 `[query]` 或 `--query <text>`。
- 如果兩者都提供，則 `--query` 優先。
- 如果兩者都未提供，則命令將以錯誤退出。
- `--agent <id>`：範圍限制為單一代理（預設：預設代理）。
- `--max-results <n>`：限制返回的結果數量。
- `--min-score <n>`：過濾低分數的匹配項。
- `--json`：列印 JSON 結果。

[[BLOCK_1]]

- `memory index --verbose` 列印每個階段的詳細資訊（提供者、模型、來源、批次活動）。
- `memory status` 包含透過 `memorySearch.extraPaths` 設定的任何額外路徑。
- 如果有效的活動記憶體遠端 API 金鑰欄位被設定為 SecretRefs，該命令會從活動閘道快照中解析這些值。如果閘道不可用，該命令會快速失敗。
- 閘道版本不一致注意：此命令路徑需要支援 `secrets.resolve` 的閘道；舊版閘道會返回未知方法錯誤。
