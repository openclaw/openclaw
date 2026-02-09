---
summary: "用於 `openclaw status` 的 CLI 參考文件（診斷、探測、使用情況快照）"
read_when:
  - 您想要快速診斷頻道健康狀態 + 最近的工作階段收件者
  - 27. 你想要可貼上的「全部」狀態以利除錯
title: "cli/status.md"
---

# `openclaw status`

28. 通道與工作階段的診斷資訊。

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

注意事項：

- `--deep` 會執行即時探測（WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal）。
- 29. 當設定了多個代理時，輸出會包含各代理的工作階段儲存區。
- 30. 概覽在可用時會包含 Gateway 與節點主機服務的安裝／執行期狀態。
- 概覽包含更新通道 + git SHA（用於來源檢出檢查）。
- 更新資訊會顯示於概覽；若有可用更新，狀態會提示執行 `openclaw update`（請參閱 [Updating](/install/updating)）。
