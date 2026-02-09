---
summary: "Manifest plugin + yêu cầu JSON Schema (xác thực cấu hình nghiêm ngặt)"
read_when:
  - Bạn đang xây dựng một plugin OpenClaw
  - Bạn cần phát hành schema cấu hình plugin hoặc gỡ lỗi các lỗi xác thực plugin
title: "Manifest Plugin"
---

# Manifest plugin (openclaw.plugin.json)

Every plugin **must** ship a `openclaw.plugin.json` file in the **plugin root**.
OpenClaw uses this manifest to validate configuration **without executing plugin
code**. Missing or invalid manifests are treated as plugin errors and block
config validation.

Xem hướng dẫn đầy đủ về hệ thống plugin: [Plugins](/tools/plugin).

## Trường bắt buộc

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Các khóa bắt buộc:

- `id` (string): id plugin chuẩn.
- `configSchema` (object): JSON Schema cho cấu hình plugin (nhúng trực tiếp).

Các khóa tùy chọn:

- `kind` (string): loại plugin (ví dụ: `"memory"`).
- `channels` (array): các id kênh do plugin này đăng ký (ví dụ: `["matrix"]`).
- `providers` (array): các id nhà cung cấp do plugin này đăng ký.
- `skills` (array): các thư mục skill cần tải (tương đối so với thư mục gốc của plugin).
- `name` (string): tên hiển thị của plugin.
- `description` (string): mô tả ngắn cho plugin.
- `uiHints` (object): nhãn/placeholder/cờ nhạy cảm của trường cấu hình để render UI.
- `version` (string): phiên bản plugin (chỉ mang tính thông tin).

## Yêu cầu JSON Schema

- **Mỗi plugin phải cung cấp một JSON Schema**, ngay cả khi không nhận cấu hình.
- Chấp nhận schema rỗng (ví dụ: `{ "type": "object", "additionalProperties": false }`).
- Schema được xác thực tại thời điểm đọc/ghi cấu hình, không phải lúc chạy.

## Hành vi xác thực

- Các khóa `channels.*` không xác định là **lỗi**, trừ khi id kênh được khai báo bởi
  một manifest plugin.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, and `plugins.slots.*`
  must reference **discoverable** plugin ids. Unknown ids are **errors**.
- Nếu một plugin đã được cài đặt nhưng manifest hoặc schema bị hỏng hoặc thiếu,
  việc xác thực sẽ thất bại và Doctor báo lỗi plugin.
- Nếu cấu hình plugin tồn tại nhưng plugin bị **vô hiệu hóa**, cấu hình vẫn được giữ lại và
  một **cảnh báo** sẽ hiển thị trong Doctor + logs.

## Ghi chú

- Manifest là **bắt buộc cho tất cả plugin**, bao gồm cả các plugin tải từ hệ thống tệp cục bộ.
- Runtime vẫn tải module plugin riêng; manifest chỉ dùng cho
  khám phá + xác thực.
- Nếu plugin của bạn phụ thuộc vào module native, hãy ghi rõ các bước build và mọi
  yêu cầu allowlist của trình quản lý gói (ví dụ: pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
