---
summary: "CLI reference for `openclaw status` (diagnostics, probes, usage snapshots)"
read_when:
  - You want a quick diagnosis of channel health + recent session recipients
  - You want a pasteable “all” status for debugging
title: status
---

# `openclaw status`

[[BLOCK_1]]  
通道和會話的診斷。  
[[BLOCK_1]]

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Notes:

- `--deep` 執行即時探測（WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal）。
- 當設定多個代理時，輸出包括每個代理的會話存儲。
- 概覽包括網關 + 節點主機服務的安裝/執行狀態（如可用）。
- 概覽包括更新通道 + git SHA（用於源程式碼檢查）。
- 更新資訊會在概覽中顯示；如果有可用的更新，狀態會提示執行 `openclaw update`（請參見 [更新](/install/updating)）。
- 只讀狀態會顯示 (`status`, `status --json`, `status --all`)，在可能的情況下解析支援的 SecretRefs 以針對其目標設定路徑。
- 如果設定了支援的通道 SecretRef，但在當前命令路徑中不可用，狀態將保持為只讀，並報告降級輸出而不是崩潰。人類輸出會顯示警告，例如「在此命令路徑中設定的 token 不可用」，而 JSON 輸出包括 `secretDiagnostics`。
