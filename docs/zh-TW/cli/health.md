---
summary: "CLI 參考文件，說明 `openclaw health`（透過 RPC 存取的 Gateway 健康狀態端點）"
read_when:
  - 你想快速檢查執行中的 Gateway 健康狀態時
title: "health"
---

# `openclaw health`

從執行中的 Gateway 取得健康狀態。

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

注意事項：

- `--verbose` 會執行即時偵測，並在設定多個帳號時列出每個帳號的耗時。
- 當設定多個智慧代理時，輸出內容會包含每個智慧代理的工作階段儲存空間。
