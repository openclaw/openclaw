---
summary: CLI reference for `openclaw tui` (terminal UI connected to the Gateway)
read_when:
  - You want a terminal UI for the Gateway (remote-friendly)
  - You want to pass url/token/session from scripts
title: tui
---

# `openclaw tui`

打開連接到 Gateway 的終端 UI。

[[BLOCK_1]]

- TUI 指南: [TUI](/web/tui)

[[BLOCK_1]]

- `tui` 會在可能的情況下解析設定的網關認證 SecretRefs 以進行 token/password 認證 (`env`/`file`/`exec` 提供者)。
- 當從設定的代理工作區目錄內啟動時，TUI 會自動選擇該代理作為會話金鑰的預設值（除非 `--session` 被明確設定為 `agent:<id>:...`）。

## Examples

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
# when run inside an agent workspace, infers that agent automatically
openclaw tui --session bugfix
```
