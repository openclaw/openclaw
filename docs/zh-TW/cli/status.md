---
summary: "CLI reference for `openclaw status` (diagnostics, probes, usage snapshots)"
read_when:
  - You want a quick diagnosis of channel health + recent session recipients
  - You want a pasteable “all” status for debugging
title: status
---

# `openclaw status`

頻道與會話的診斷。

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

說明：

- `--deep` 執行即時探測（WhatsApp Web、Telegram、Discord、Google Chat、Slack、Signal）。
- 輸出包含多代理設定時的每個代理會話存儲。
- 概覽包含 Gateway 與節點主機服務的安裝/執行狀態（若可用）。
- 概覽包含更新頻道與 git SHA（針對原始碼檢出）。
- 更新資訊會顯示在概覽中；若有可用更新，狀態會提示執行 `openclaw update`（參見 [更新](/install/updating)）。
- 只讀狀態顯示 (`status`、`status --json`、`status --all`) 會在可能的情況下解析其目標設定路徑所支援的 SecretRefs。
- 若設定了支援的頻道 SecretRef，但在當前指令路徑中無法取得，狀態將維持只讀並回報降級輸出，而非崩潰。人類可讀輸出會顯示警告，如「此指令路徑中無法取得設定的 token」，JSON 輸出則包含 `secretDiagnostics`。
