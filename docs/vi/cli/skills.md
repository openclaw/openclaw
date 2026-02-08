---
summary: "Tài liệu tham chiếu CLI cho `openclaw skills` (list/info/check) và điều kiện đủ của skill"
read_when:
  - Bạn muốn xem những skill nào đang có sẵn và sẵn sàng chạy
  - Bạn muốn gỡ lỗi các binary/biến môi trường/cấu hình còn thiếu cho skill
title: "Skills"
x-i18n:
  source_path: cli/skills.md
  source_hash: 7878442c88a27ec8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:29Z
---

# `openclaw skills`

Kiểm tra các skill (đóng gói sẵn + trong workspace + ghi đè được quản lý) và xem cái nào đủ điều kiện so với các yêu cầu còn thiếu.

Liên quan:

- Hệ thống Skills: [Skills](/tools/skills)
- Cấu hình Skills: [Skills config](/tools/skills-config)
- Cài đặt ClawHub: [ClawHub](/tools/clawhub)

## Lệnh

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
