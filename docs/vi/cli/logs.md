---
summary: "Tài liệu tham chiếu CLI cho `openclaw logs` (theo dõi log Gateway qua RPC)"
read_when:
  - Bạn cần theo dõi log Gateway từ xa (không cần SSH)
  - Bạn muốn các dòng log JSON cho công cụ
title: "nhật ký"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:21Z
---

# `openclaw logs`

Theo dõi các file log của Gateway qua RPC (hoạt động ở chế độ từ xa).

Liên quan:

- Tổng quan về logging: [Logging](/logging)

## Ví dụ

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
