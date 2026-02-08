---
summary: "Tài liệu tham chiếu CLI cho `openclaw tui` (UI terminal kết nối với Gateway)"
read_when:
  - Bạn muốn một UI terminal cho Gateway (thân thiện với làm việc từ xa)
  - Bạn muốn truyền url/token/session từ các script
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:27Z
---

# `openclaw tui`

Mở UI terminal được kết nối với Gateway.

Liên quan:

- Hướng dẫn TUI: [TUI](/web/tui)

## Ví dụ

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
