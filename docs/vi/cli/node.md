---
summary: "Tài liệu tham chiếu CLI cho `openclaw node` (máy chủ node không giao diện)"
read_when:
  - Chạy máy chủ node không giao diện
  - Ghép cặp một node không phải macOS cho system.run
title: "node"
---

# `openclaw node`

Chạy một **máy chủ node không giao diện** kết nối tới Gateway WebSocket và cung cấp
`system.run` / `system.which` trên máy này.

## Vì sao nên dùng máy chủ node?

Dùng máy chủ node khi bạn muốn các tác tử **chạy lệnh trên các máy khác** trong mạng
của mình mà không cần cài đặt ứng dụng đồng hành macOS đầy đủ trên các máy đó.

Các trường hợp sử dụng phổ biến:

- Chạy lệnh trên các máy Linux/Windows từ xa (máy build, máy phòng lab, NAS).
- Giữ việc exec **sandboxed** trên gateway, nhưng ủy quyền các lần chạy đã được phê duyệt cho các máy chủ khác.
- Cung cấp một đích thực thi nhẹ, không giao diện cho tự động hóa hoặc các node CI.

Việc thực thi vẫn được bảo vệ bằng **phê duyệt exec** và danh sách cho phép theo từng tác tử trên máy chủ node, giúp bạn giữ quyền truy cập lệnh ở phạm vi rõ ràng và cụ thể.

## Browser proxy (zero-config)

Các node host tự động quảng bá proxy trình duyệt nếu `browser.enabled` không bị vô hiệu hóa trên node. Điều này cho phép agent sử dụng tự động hóa trình duyệt trên node đó
mà không cần cấu hình thêm.

Nếu cần, hãy tắt trên node:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Chạy (foreground)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Tùy chọn:

- `--host <host>`: Máy chủ Gateway WebSocket (mặc định: `127.0.0.1`)
- `--port <port>`: Cổng Gateway WebSocket (mặc định: `18789`)
- `--tls`: Dùng TLS cho kết nối gateway
- `--tls-fingerprint <sha256>`: Dấu vân tay chứng chỉ TLS mong đợi (sha256)
- `--node-id <id>`: Ghi đè id của node (xóa token ghép cặp)
- `--display-name <name>`: Ghi đè tên hiển thị của node

## Dịch vụ (background)

Cài đặt máy chủ node không giao diện dưới dạng dịch vụ người dùng.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Tùy chọn:

- `--host <host>`: Máy chủ Gateway WebSocket (mặc định: `127.0.0.1`)
- `--port <port>`: Cổng Gateway WebSocket (mặc định: `18789`)
- `--tls`: Dùng TLS cho kết nối gateway
- `--tls-fingerprint <sha256>`: Dấu vân tay chứng chỉ TLS mong đợi (sha256)
- `--node-id <id>`: Ghi đè id của node (xóa token ghép cặp)
- `--display-name <name>`: Ghi đè tên hiển thị của node
- `--runtime <runtime>`: Môi trường chạy dịch vụ (`node` hoặc `bun`)
- `--force`: Cài đặt lại/ghi đè nếu đã được cài

Quản lý dịch vụ:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Dùng `openclaw node run` cho máy chủ node chạy foreground (không dùng dịch vụ).

Các lệnh dịch vụ chấp nhận `--json` cho đầu ra có thể đọc bằng máy.

## Ghép cặp

Kết nối đầu tiên sẽ tạo một yêu cầu ghép cặp node đang chờ trên Gateway.
Phê duyệt thông qua:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Máy chủ node lưu id node, token, tên hiển thị và thông tin kết nối gateway tại
`~/.openclaw/node.json`.

## Phê duyệt exec

`system.run` được kiểm soát bằng các phê duyệt exec cục bộ:

- `~/.openclaw/exec-approvals.json`
- [Phê duyệt exec](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (chỉnh sửa từ Gateway)
