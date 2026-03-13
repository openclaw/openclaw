---
summary: CLI reference for `openclaw tui` (terminal UI connected to the Gateway)
read_when:
  - You want a terminal UI for the Gateway (remote-friendly)
  - You want to pass url/token/session from scripts
title: tui
---

# `openclaw tui`

開啟連接至 Gateway 的終端機介面。

相關資訊：

- TUI 指南：[TUI](/web/tui)

注意事項：

- `tui` 會在可能的情況下解析已設定的 gateway 認證 SecretRefs，用於 token/密碼認證（`env`/`file`/`exec` 提供者）。
- 當從已設定的 agent 工作目錄內啟動時，TUI 會自動選擇該 agent 作為會話金鑰的預設（除非 `--session` 被明確 `agent:<id>:...`）。

## 範例

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
# when run inside an agent workspace, infers that agent automatically
openclaw tui --session bugfix
```
