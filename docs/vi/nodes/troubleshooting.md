---
summary: "Khắc phục sự cố ghép cặp node, yêu cầu chạy nền trước, quyền truy cập và lỗi công cụ"
read_when:
  - Node đã kết nối nhưng các công cụ camera/canvas/screen/exec không hoạt động
  - Bạn cần hiểu mô hình ghép cặp node so với phê duyệt
title: "Xử lý sự cố Node"
---

# Xử lý sự cố node

Dùng trang này khi node hiển thị là đã kết nối trong trạng thái nhưng các công cụ của node bị lỗi.

## Thứ tự kiểm tra lệnh

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Sau đó chạy các kiểm tra riêng cho node:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Dấu hiệu hoạt động bình thường:

- Node đã kết nối và được ghép cặp cho vai trò `node`.
- `nodes describe` bao gồm khả năng bạn đang gọi.
- Phê duyệt exec hiển thị đúng chế độ/danh sách cho phép mong đợi.

## Yêu cầu chạy nền trước

`canvas.*`, `camera.*` và `screen.*` chỉ hoạt động khi ở nền trước trên các node iOS/Android.

Kiểm tra và khắc phục nhanh:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

Nếu bạn thấy `NODE_BACKGROUND_UNAVAILABLE`, hãy đưa ứng dụng node ra nền trước và thử lại.

## Ma trận quyền

| Khả năng                     | iOS                                                          | Android                                                | Ứng dụng node macOS                                 | Mã lỗi thường gặp              |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Camera (+ mic cho âm thanh clip)          | Camera (+ mic cho âm thanh clip)    | Camera (+ mic cho âm thanh clip) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Ghi màn hình (+ mic tùy chọn)             | Nhắc chụp màn hình (+ mic tùy chọn) | Ghi màn hình                                        | `*_PERMISSION_REQUIRED`        |
| `location.get`               | Khi đang dùng hoặc Luôn luôn (tùy chế độ) | Vị trí nền trước/nền sau theo chế độ                   | Quyền vị trí                                        | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (đường dẫn máy chủ node)              | n/a (đường dẫn máy chủ node)        | Cần phê duyệt exec                                  | `SYSTEM_RUN_DENIED`            |

## Ghép cặp so với phê duyệt

Đây là hai cổng khác nhau:

1. **Ghép cặp thiết bị**: node này có thể kết nối tới gateway (cổng kết nối) không?
2. **Phê duyệt exec**: node này có thể chạy một lệnh shell cụ thể không?

Kiểm tra nhanh:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Nếu thiếu ghép cặp, hãy phê duyệt thiết bị node trước.1) Nếu việc ghép nối ổn nhưng `system.run` thất bại, hãy sửa quyền thực thi/allowlist.

## Mã lỗi node thường gặp

- `NODE_BACKGROUND_UNAVAILABLE` → ứng dụng đang ở nền sau; đưa lên nền trước.
- `CAMERA_DISABLED` → công tắc camera bị tắt trong cài đặt node.
- `*_PERMISSION_REQUIRED` → thiếu/bị từ chối quyền của hệ điều hành.
- `LOCATION_DISABLED` → chế độ vị trí đang tắt.
- `LOCATION_PERMISSION_REQUIRED` → chế độ vị trí được yêu cầu chưa được cấp.
- `LOCATION_BACKGROUND_UNAVAILABLE` → ứng dụng ở nền sau nhưng chỉ có quyền Khi đang dùng.
- `SYSTEM_RUN_DENIED: approval required` → yêu cầu exec cần phê duyệt rõ ràng.
- `SYSTEM_RUN_DENIED: allowlist miss` → lệnh bị chặn bởi chế độ danh sách cho phép.

## Vòng khôi phục nhanh

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

Nếu vẫn chưa khắc phục được:

- Phê duyệt lại ghép cặp thiết bị.
- Mở lại ứng dụng node (đưa lên nền trước).
- Cấp lại quyền hệ điều hành.
- Tạo lại/điều chỉnh chính sách phê duyệt exec.

Liên quan:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
