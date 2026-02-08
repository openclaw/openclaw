---
summary: "Gia cố danh sách cho phép Telegram: chuẩn hóa tiền tố + khoảng trắng"
read_when:
  - Xem lại các thay đổi lịch sử của danh sách cho phép Telegram
title: "Gia cố danh sách cho phép Telegram"
x-i18n:
  source_path: experiments/plans/group-policy-hardening.md
  source_hash: 70569968857d4084
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:50Z
---

# Gia cố danh sách cho phép Telegram

**Ngày**: 2026-01-05  
**Trạng thái**: Hoàn tất  
**PR**: #216

## Tóm tắt

Danh sách cho phép Telegram hiện chấp nhận các tiền tố `telegram:` và `tg:` không phân biệt chữ hoa/chữ thường, và dung thứ
khoảng trắng vô tình. Điều này đồng bộ việc kiểm tra danh sách cho phép đầu vào với chuẩn hóa gửi đi.

## Thay đổi gì

- Các tiền tố `telegram:` và `tg:` được xử lý như nhau (không phân biệt chữ hoa/chữ thường).
- Các mục trong danh sách cho phép được cắt khoảng trắng; các mục rỗng bị bỏ qua.

## Ví dụ

Tất cả các giá trị sau đều được chấp nhận cho cùng một ID:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Vì sao quan trọng

Việc sao chép/dán từ log hoặc ID chat thường bao gồm tiền tố và khoảng trắng. Chuẩn hóa giúp tránh
âm tính giả khi quyết định có phản hồi trong DM hoặc nhóm hay không.

## Tài liệu liên quan

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
