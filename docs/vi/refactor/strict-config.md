---
summary: "Xác thực cấu hình nghiêm ngặt + migration chỉ qua doctor"
read_when:
  - Thiết kế hoặc triển khai hành vi xác thực cấu hình
  - Làm việc với migration cấu hình hoặc quy trình doctor
  - Xử lý schema cấu hình plugin hoặc kiểm soát việc tải plugin
title: "Xác thực cấu hình nghiêm ngặt"
---

# Xác thực cấu hình nghiêm ngặt (migration chỉ qua doctor)

## Mục tiêu

- **Từ chối mọi khóa cấu hình không xác định ở mọi nơi** (gốc + lồng nhau).
- **Từ chối cấu hình plugin nếu không có schema**; không tải plugin đó.
- **Loại bỏ auto-migration kế thừa khi tải**; migration chỉ chạy qua doctor.
- **Tự động chạy doctor (dry-run) khi khởi động**; nếu không hợp lệ, chặn các lệnh không mang tính chẩn đoán.

## Không nằm trong mục tiêu

- Tương thích ngược khi tải (các khóa kế thừa không tự động migrate).
- Âm thầm loại bỏ các khóa không được nhận diện.

## Quy tắc xác thực nghiêm ngặt

- Cấu hình phải khớp chính xác với schema ở mọi cấp.
- Các khóa không xác định là lỗi xác thực (không cho phép passthrough ở gốc hay lồng nhau).
- Các khóa ` ` là lỗi trừ khi manifest của plugin khai báo channel id.2. `.config` phải được xác thực bởi schema của plugin.
  - Nếu plugin không có schema, **từ chối tải plugin** và hiển thị lỗi rõ ràng.
- OpenClaw sử dụng một thư mục workspace chuyên dụng cho agent.Sử dụng `pnpm` (Node 22+) từ thư mục gốc của repo.
- Manifest plugin (`openclaw.plugin.json`) là bắt buộc cho tất cả plugin.

## Thực thi schema plugin

- Mỗi plugin cung cấp một JSON Schema nghiêm ngặt cho cấu hình của nó (nhúng trong manifest).
- Luồng tải plugin:
  1. Phân giải manifest + schema của plugin (`openclaw.plugin.json`).
  2. Xác thực cấu hình theo schema.
  3. Nếu thiếu schema hoặc cấu hình không hợp lệ: chặn tải plugin, ghi nhận lỗi.
- Thông báo lỗi bao gồm:
  - Plugin id
  - Lý do (thiếu schema / cấu hình không hợp lệ)
  - Đường dẫn (path) không vượt qua xác thực
- Plugin bị vô hiệu hóa vẫn giữ cấu hình, nhưng Doctor + log sẽ hiển thị cảnh báo.

## Luồng Doctor

- Doctor chạy **mọi lần** cấu hình được tải (mặc định là dry-run).
- Nếu cấu hình không hợp lệ:
  - In ra bản tóm tắt + lỗi có thể hành động.
  - Hướng dẫn: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - Áp dụng migration.
  - Loại bỏ các khóa không xác định.
  - Ghi cấu hình đã cập nhật.

## Kiểm soát lệnh (khi cấu hình không hợp lệ)

Được phép (chỉ chẩn đoán):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Mọi thứ khác phải hard-fail với: “Config invalid.” Hãy giữ nó luôn được cập nhật.

## Định dạng UX lỗi

- Một tiêu đề tóm tắt duy nhất.
- Các phần được nhóm:
  - Khóa không xác định (đường dẫn đầy đủ)
  - Khóa kế thừa / cần migration
  - Lỗi tải plugin (plugin id + lý do + đường dẫn)

## Điểm chạm triển khai

- `src/config/zod-schema.ts`: loại bỏ passthrough ở gốc; object nghiêm ngặt ở mọi nơi.
- `src/config/zod-schema.providers.ts`: đảm bảo schema kênh nghiêm ngặt.
- `src/config/validation.ts`: thất bại khi gặp khóa không xác định; không áp dụng migration kế thừa.
- `src/config/io.ts`: loại bỏ auto-migration kế thừa; luôn chạy doctor dry-run.
- `src/config/legacy*.ts`: chuyển việc sử dụng sang doctor בלבד.
- `src/plugins/*`: thêm registry schema + kiểm soát.
- Kiểm soát lệnh CLI trong `src/cli`.

## Kiểm thử

- Từ chối khóa không xác định (gốc + lồng nhau).
- Plugin thiếu schema → chặn tải plugin với lỗi rõ ràng.
- Cấu hình không hợp lệ → chặn khởi động gateway ngoại trừ các lệnh chẩn đoán.
- Doctor dry-run tự động; `doctor --fix` ghi cấu hình đã được sửa.
