---
summary: "openclaw health 的 CLI 參考 (透過 RPC 的 Gateway 健康端點)"
read_when:
  - 當您想要快速檢查執行中的 Gateway 健康狀況時
title: "健康"
---

# `openclaw health`

從執行中的 Gateway 取得健康狀況。

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

備註：

- `--verbose` 會在設定多個帳號時執行即時探測並列印每個帳號的時間。
- 當設定多個智慧代理時，輸出內容包括每個智慧代理的工作階段儲存。
