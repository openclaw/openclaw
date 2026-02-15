---
summary: "CLI 參考文件，用於 `openclaw status`（診斷、探測、使用狀況快照）"
read_when:
  - 您想快速診斷頻道健康狀態 + 近期工作階段接收者
  - 您想要一個可貼上的「所有」狀態用於疑難排解
title: "status"
---

# `openclaw status`

頻道的診斷 + 工作階段。

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

備註：

- `--deep` 執行即時探測（WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal）。
- 當配置多個智慧代理時，輸出內容包含每個智慧代理的工作階段儲存。
- 總覽內容包含 Gateway + 節點主機服務安裝/執行時狀態（如果可用）。
- 總覽內容包含更新頻道 + git SHA（用於原始碼檢查）。
- 更新資訊會顯示在總覽中；如果有可用的更新，status 會提示執行 `openclaw update`（請參閱[更新](/install/updating)）。
