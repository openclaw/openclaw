---
summary: "Tham chiếu CLI cho `openclaw system` (sự kiện hệ thống, heartbeat, presence)"
read_when:
  - Bạn muốn đưa một sự kiện hệ thống vào hàng đợi mà không cần tạo cron job
  - Bạn cần bật hoặc tắt heartbeat
  - Bạn muốn kiểm tra các mục presence của hệ thống
title: "system"
x-i18n:
  source_path: cli/system.md
  source_hash: 36ae5dbdec327f5a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:25Z
---

# `openclaw system`

Các trợ giúp cấp hệ thống cho Gateway: đưa sự kiện hệ thống vào hàng đợi, kiểm soát heartbeat,
và xem presence.

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Đưa một sự kiện hệ thống vào hàng đợi trên phiên **main**. Heartbeat tiếp theo sẽ chèn
nó như một dòng `System:` trong prompt. Dùng `--mode now` để kích hoạt heartbeat
ngay lập tức; `next-heartbeat` sẽ đợi đến nhịp theo lịch tiếp theo.

Flags:

- `--text <text>`: văn bản sự kiện hệ thống bắt buộc.
- `--mode <mode>`: `now` hoặc `next-heartbeat` (mặc định).
- `--json`: đầu ra có thể đọc bằng máy.

## `system heartbeat last|enable|disable`

Điều khiển heartbeat:

- `last`: hiển thị sự kiện heartbeat gần nhất.
- `enable`: bật lại heartbeat (dùng khi chúng đã bị tắt).
- `disable`: tạm dừng heartbeat.

Flags:

- `--json`: đầu ra có thể đọc bằng máy.

## `system presence`

Liệt kê các mục presence hệ thống hiện tại mà Gateway biết đến (node,
instance, và các dòng trạng thái tương tự).

Flags:

- `--json`: đầu ra có thể đọc bằng máy.

## Notes

- Yêu cầu Gateway đang chạy và có thể truy cập được bằng cấu hình hiện tại của bạn (cục bộ hoặc từ xa).
- Các sự kiện hệ thống là tạm thời và không được lưu lại qua các lần khởi động lại.
