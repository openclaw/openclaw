---
summary: "Tài liệu tham khảo CLI cho `openclaw agent` (gửi một lượt tác tử qua Gateway)"
read_when:
  - Bạn muốn chạy một lượt tác tử từ script (tùy chọn gửi phản hồi)
title: "tác tử"
---

# `openclaw agent`

Chạy một lượt agent thông qua Gateway (dùng `--local` cho chế độ nhúng).
Dùng `--agent <id>` để nhắm trực tiếp tới một agent đã cấu hình.

Liên quan:

- Công cụ gửi tác tử: [Agent send](/tools/agent-send)

## Ví dụ

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
