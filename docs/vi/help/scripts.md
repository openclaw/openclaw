---
summary: "Các script trong kho lưu trữ: mục đích, phạm vi và lưu ý an toàn"
read_when:
  - Chạy các script từ kho lưu trữ
  - Thêm hoặc thay đổi script trong ./scripts
title: "Scripts"
---

# Scripts

Thư mục `scripts/` chứa các script hỗ trợ cho workflow cục bộ và các tác vụ vận hành.
Hãy dùng những script này khi một tác vụ gắn rõ ràng với một script; nếu không thì ưu tiên CLI.

## Quy ước

- Script là **không bắt buộc** trừ khi được tham chiếu trong tài liệu hoặc danh sách kiểm tra phát hành.
- Ưu tiên các bề mặt CLI khi đã có (ví dụ: giám sát xác thực dùng `openclaw models status --check`).
- Giả định script phụ thuộc vào máy chủ; hãy đọc kỹ trước khi chạy trên máy mới.

## Script giám sát xác thực

Các script giám sát xác thực được tài liệu hóa tại đây:
[/automation/auth-monitoring](/automation/auth-monitoring)

## Khi thêm script

- Giữ script tập trung và có tài liệu.
- Thêm một mục ngắn trong tài liệu liên quan (hoặc tạo mới nếu chưa có).
