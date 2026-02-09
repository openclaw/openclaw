---
summary: "Tài liệu tham chiếu CLI cho `openclaw logs` (theo dõi log Gateway qua RPC)"
read_when:
  - Bạn cần theo dõi log Gateway từ xa (không cần SSH)
  - Bạn muốn các dòng log JSON cho công cụ
title: "nhật ký"
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
