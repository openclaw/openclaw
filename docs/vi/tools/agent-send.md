---
summary: "Chạy trực tiếp CLI `openclaw agent` (có tùy chọn gửi kết quả)"
read_when:
  - Thêm hoặc chỉnh sửa điểm vào CLI của agent
title: "Gửi Agent"
---

# `openclaw agent` (chạy agent trực tiếp)

`openclaw agent` runs a single agent turn without needing an inbound chat message.
By default it goes **through the Gateway**; add `--local` to force the embedded
runtime on the current machine.

## Hành vi

- Bắt buộc: `--message <text>`
- Chọn phiên:
  - `--to <dest>` suy ra khóa phiên (mục tiêu nhóm/kênh giữ nguyên cách ly; chat trực tiếp gộp về `main`), **hoặc**
  - `--session-id <id>` tái sử dụng một phiên hiện có theo id, **hoặc**
  - `--agent <id>` nhắm trực tiếp tới một agent đã cấu hình (dùng khóa phiên `main` của agent đó)
- Chạy cùng runtime agent nhúng như các phản hồi đến từ inbound thông thường.
- Các cờ thinking/verbose được lưu bền vào kho phiên.
- Đầu ra:
  - mặc định: in văn bản trả lời (kèm các dòng `MEDIA:<url>`)
  - `--json`: in payload có cấu trúc + metadata
- Tùy chọn gửi lại kết quả về một kênh với `--deliver` + `--channel` (định dạng mục tiêu khớp với `openclaw message --target`).
- Dùng `--reply-channel`/`--reply-to`/`--reply-account` để ghi đè việc gửi mà không thay đổi phiên.

Nếu Gateway không thể truy cập, CLI sẽ **tự động chuyển sang** chạy cục bộ nhúng.

## Ví dụ

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Cờ

- `--local`: chạy cục bộ (yêu cầu khóa API của nhà cung cấp mô hình trong shell)
- `--deliver`: gửi phản hồi tới kênh đã chọn
- `--channel`: kênh gửi (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, mặc định: `whatsapp`)
- `--reply-to`: ghi đè mục tiêu gửi
- `--reply-channel`: ghi đè kênh gửi
- `--reply-account`: ghi đè id tài khoản gửi
- `--thinking <off|minimal|low|medium|high|xhigh>`: lưu bền mức thinking (chỉ cho mô hình GPT-5.2 + Codex)
- `--verbose <on|full|off>`: lưu bền mức verbose
- `--timeout <seconds>`: ghi đè thời gian chờ của agent
- `--json`: xuất JSON có cấu trúc
