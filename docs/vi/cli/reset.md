---
summary: "Tham chiếu CLI cho `openclaw reset` (đặt lại trạng thái/cấu hình cục bộ)"
read_when:
  - Bạn muốn xóa trạng thái cục bộ nhưng vẫn giữ CLI đã cài đặt
  - Bạn muốn chạy dry-run để xem những gì sẽ bị xóa
title: "đặt lại"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:22Z
---

# `openclaw reset`

Đặt lại cấu hình/trạng thái cục bộ (giữ nguyên CLI đã cài đặt).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
