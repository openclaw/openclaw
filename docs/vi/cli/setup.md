---
summary: "Tham chiếu CLI cho `openclaw setup` (khởi tạo cấu hình + workspace)"
read_when:
  - Bạn đang thiết lập lần đầu mà không dùng trình hướng dẫn onboarding đầy đủ
  - Bạn muốn đặt đường dẫn workspace mặc định
title: "thiết lập"
x-i18n:
  source_path: cli/setup.md
  source_hash: 7f3fc8b246924edf
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:27Z
---

# `openclaw setup`

Khởi tạo `~/.openclaw/openclaw.json` và workspace của tác tử.

Liên quan:

- Bắt đầu: [Bắt đầu](/start/getting-started)
- Trình hướng dẫn: [Hướng dẫn ban đầu](/start/onboarding)

## Ví dụ

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

Để chạy trình hướng dẫn thông qua setup:

```bash
openclaw setup --wizard
```
