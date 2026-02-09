---
summary: "Gia cố danh sách cho phép Telegram: chuẩn hóa tiền tố + khoảng trắng"
read_when:
  - Xem lại các thay đổi lịch sử của danh sách cho phép Telegram
title: "Gia cố danh sách cho phép Telegram"
---

# Gia cố danh sách cho phép Telegram

**Ngày**: 2026-01-05  
**Trạng thái**: Hoàn tất  
**PR**: #216

## Tóm tắt

Điều này căn chỉnh kiểm tra allowlist đầu vào với việc chuẩn hóa khi gửi đầu ra. Điều này căn chỉnh các kiểm tra allowlist inbound với việc chuẩn hóa gửi outbound.

## Thay đổi gì

- Các tiền tố `telegram:` và `tg:` được xử lý như nhau (không phân biệt chữ hoa/chữ thường).
- Các mục trong danh sách cho phép được cắt khoảng trắng; các mục rỗng bị bỏ qua.

## Ví dụ

Tất cả các giá trị sau đều được chấp nhận cho cùng một ID:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Vì sao quan trọng

Sao chép/dán từ log hoặc ID chat thường bao gồm tiền tố và khoảng trắng. Chuẩn hóa giúp tránh
kết quả âm tính giả khi quyết định có phản hồi trong DM hay nhóm hay không.

## Tài liệu liên quan

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
