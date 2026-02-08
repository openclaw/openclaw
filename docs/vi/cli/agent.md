---
summary: "Tài liệu tham khảo CLI cho `openclaw agent` (gửi một lượt tác tử qua Gateway)"
read_when:
  - Bạn muốn chạy một lượt tác tử từ script (tùy chọn gửi phản hồi)
title: "tác tử"
x-i18n:
  source_path: cli/agent.md
  source_hash: dcf12fb94e207c68
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:10Z
---

# `openclaw agent`

Chạy một lượt tác tử qua Gateway (dùng `--local` cho nhúng).
Dùng `--agent <id>` để nhắm trực tiếp tới một tác tử đã được cấu hình.

Liên quan:

- Công cụ gửi tác tử: [Agent send](/tools/agent-send)

## Ví dụ

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
