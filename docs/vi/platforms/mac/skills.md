---
summary: "Giao diện cài đặt Skills trên macOS và trạng thái được hậu thuẫn bởi gateway"
read_when:
  - Cập nhật giao diện cài đặt Skills trên macOS
  - Thay đổi cơ chế kiểm soát hoặc hành vi cài đặt Skills
title: "Skills"
---

# Skills (macOS)

Ứng dụng macOS hiển thị Skills của OpenClaw thông qua gateway; ứng dụng không phân tích Skills cục bộ.

## Nguồn dữ liệu

- `skills.status` (gateway) trả về tất cả Skills cùng với điều kiện đủ và các yêu cầu còn thiếu
  (bao gồm các khối allowlist cho Skills được đóng gói).
- Các yêu cầu được suy ra từ `metadata.openclaw.requires` trong mỗi `SKILL.md`.

## Hành động cài đặt

- `metadata.openclaw.install` xác định các tùy chọn cài đặt (brew/node/go/uv).
- Ứng dụng gọi `skills.install` để chạy trình cài đặt trên máy chủ gateway.
- Gateway chỉ hiển thị một trình cài đặt ưu tiên khi có nhiều lựa chọn
  (brew khi có sẵn, nếu không thì trình quản lý node từ `skills.install`, mặc định là npm).

## Khóa Env/API

- The app stores keys in `~/.openclaw/openclaw.json` under `skills.entries.<skillKey>`.
- `skills.update` vá `enabled`, `apiKey`, và `env`.

## Chế độ từ xa

- Việc cài đặt + cập nhật cấu hình diễn ra trên máy chủ gateway (không phải máy Mac cục bộ).
