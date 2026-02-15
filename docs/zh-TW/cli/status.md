---
summary: "openclaw status 的 CLI 參考（診斷、探測、使用量快照）"
read_when:
  - 您想要快速診斷頻道健康狀況與最近的工作階段接收者
  - 您想要一個可用於除錯且可直接貼上的「完整」狀態
title: "status"
---

# `openclaw status`

頻道與工作階段的診斷資訊。

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

注意事項：

- `--deep` 會執行即時探測 (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal)。
- 當設定多個智慧代理時，輸出內容會包含每個智慧代理的工作階段儲存。
- 總覽包含 Gateway 與節點主機服務的安裝/執行狀態（若可用）。
- 總覽包含更新頻道與 git SHA（用於原始碼檢出）。
- 更新資訊會顯示在總覽中；如果有可用更新，status 會印出提示以執行 `openclaw update`（請參閱 [更新](/install/updating)）。
