---
summary: "Cách OpenClaw cung cấp các định danh mẫu thiết bị Apple thành tên thân thiện trong ứng dụng macOS."
read_when:
  - Cập nhật ánh xạ định danh mẫu thiết bị hoặc các tệp NOTICE/giấy phép
  - Thay đổi cách UI Instances hiển thị tên thiết bị
title: "Cơ sở dữ liệu mẫu thiết bị"
---

# Cơ sở dữ liệu mẫu thiết bị (tên thân thiện)

Ứng dụng đồng hành macOS hiển thị các tên mẫu thiết bị Apple thân thiện trong UI **Instances** bằng cách ánh xạ các định danh mẫu Apple (ví dụ: `iPad16,6`, `Mac16,6`) sang các tên dễ đọc cho con người.

Ánh xạ này được cung cấp dưới dạng JSON tại:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Nguồn dữ liệu

Hiện tại chúng tôi cung cấp ánh xạ từ kho lưu trữ được cấp phép MIT:

- `kyle-seongwoo-jun/apple-device-identifiers`

Để đảm bảo các bản dựng có tính xác định, các tệp JSON được ghim vào các commit thượng nguồn cụ thể (được ghi lại trong `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## Cập nhật cơ sở dữ liệu

1. Chọn các commit thượng nguồn bạn muốn ghim (một cho iOS, một cho macOS).
2. Cập nhật các giá trị băm commit trong `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. Tải lại các tệp JSON, được ghim theo các commit đó:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Đảm bảo `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` vẫn khớp với thượng nguồn (thay thế nếu giấy phép thượng nguồn thay đổi).
5. Xác minh ứng dụng macOS build sạch (không có cảnh báo):

```bash
swift build --package-path apps/macos
```
