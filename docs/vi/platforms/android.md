---
summary: "Ứng dụng Android (node): runbook kết nối + Canvas/Chat/Camera"
read_when:
  - Ghép cặp hoặc kết nối lại node Android
  - Gỡ lỗi khám phá gateway Android hoặc xác thực
  - Xác minh tính đồng bộ lịch sử chat giữa các client
title: "Ứng dụng Android"
---

# Ứng dụng Android (Node)

## Ảnh chụp nhanh hỗ trợ

- Vai trò: ứng dụng node đồng hành (Android không chạy Gateway).
- Cần Gateway: có (chạy trên macOS, Linux, hoặc Windows qua WSL2).
- Cài đặt: [Bắt đầu](/start/getting-started) + [Ghép cặp](/gateway/pairing).
- Gateway: [Runbook](/gateway) + [Cấu hình](/gateway/configuration).
  - Giao thức: [Gateway protocol](/gateway/protocol) (nodes + control plane).

## Điều khiển hệ thống

31. Điều khiển hệ thống (launchd/systemd) nằm trên host Gateway. 32. Xem [Gateway](/gateway).

## Runbook kết nối

Ứng dụng node Android ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android kết nối trực tiếp tới WebSocket của Gateway (mặc định `ws://<host>:18789`) và dùng ghép cặp do Gateway quản lý.

### Điều kiện tiên quyết

- Bạn có thể chạy Gateway trên máy “master”.
- Thiết bị/trình giả lập Android có thể truy cập WebSocket của gateway:
  - Cùng LAN với mDNS/NSD, **hoặc**
  - Cùng tailnet Tailscale sử dụng Wide-Area Bonjour / unicast DNS-SD (xem bên dưới), **hoặc**
  - Nhập thủ công máy chủ/cổng gateway (dự phòng)
- Bạn có thể chạy CLI (`openclaw`) trên máy gateway (hoặc qua SSH).

### 1. Khởi động Gateway

```bash
openclaw gateway --port 18789 --verbose
```

Xác nhận trong log bạn thấy tương tự:

- `listening on ws://0.0.0.0:18789`

Với các thiết lập chỉ dùng tailnet (khuyến nghị cho Vienna ⇄ London), bind gateway vào IP tailnet:

- Đặt `gateway.bind: "tailnet"` trong `~/.openclaw/openclaw.json` trên máy chủ gateway.
- Khởi động lại Gateway / ứng dụng menubar macOS.

### 2. Xác minh khám phá (tùy chọn)

Từ máy gateway:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Ghi chú gỡ lỗi thêm: [Bonjour](/gateway/bonjour).

#### Khám phá qua unicast DNS-SD trên tailnet (Vienna ⇄ London)

33. Khám phá Android NSD/mDNS sẽ không vượt qua các mạng khác nhau. 34. Nếu node Android của bạn và gateway ở trên các mạng khác nhau nhưng được kết nối qua Tailscale, hãy dùng Wide-Area Bonjour / unicast DNS-SD thay thế:

1. Thiết lập một vùng DNS-SD (ví dụ `openclaw.internal.`) trên máy chủ gateway và công bố các bản ghi `_openclaw-gw._tcp`.
2. Cấu hình Tailscale split DNS cho miền đã chọn, trỏ tới máy chủ DNS đó.

Chi tiết và ví dụ cấu hình CoreDNS: [Bonjour](/gateway/bonjour).

### 3. Kết nối từ Android

Trong ứng dụng Android:

- Ứng dụng giữ kết nối gateway qua **foreground service** (thông báo liên tục).
- Mở **Settings**.
- Trong **Discovered Gateways**, chọn gateway của bạn và nhấn **Connect**.
- Nếu mDNS bị chặn, dùng **Advanced → Manual Gateway** (host + port) và **Connect (Manual)**.

Sau lần ghép cặp thành công đầu tiên, Android sẽ tự động kết nối lại khi mở ứng dụng:

- Endpoint thủ công (nếu bật), nếu không
- Gateway được phát hiện lần gần nhất (best-effort).

### 4. Phê duyệt ghép cặp (CLI)

Trên máy gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Chi tiết ghép cặp: [Gateway pairing](/gateway/pairing).

### 5. Xác minh node đã kết nối

- Qua trạng thái nodes:

  ```bash
  openclaw nodes status
  ```

- Qua Gateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. Chat + lịch sử

Trang Chat của node Android dùng **primary session key** của gateway (`main`), vì vậy lịch sử và phản hồi được chia sẻ với WebChat và các client khác:

- Lịch sử: `chat.history`
- Gửi: `chat.send`
- Cập nhật đẩy (best-effort): `chat.subscribe` → `event:"chat"`

### 7. Canvas + camera

#### Gateway Canvas Host (khuyến nghị cho nội dung web)

Nếu bạn muốn node hiển thị HTML/CSS/JS thực mà tác tử có thể chỉnh sửa trên đĩa, hãy trỏ node tới canvas host của Gateway.

Lưu ý: node dùng canvas host độc lập tại `canvasHost.port` (mặc định `18793`).

1. Tạo `~/.openclaw/workspace/canvas/index.html` trên máy chủ gateway.

2. Điều hướng node tới đó (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (tùy chọn): nếu cả hai thiết bị đều trên Tailscale, dùng tên MagicDNS hoặc IP tailnet thay cho `.local`, ví dụ `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

35. Server này chèn một client live-reload vào HTML và reload khi file thay đổi.
36. Host A2UI nằm tại `http://<gateway-host>:18793/__openclaw__/a2ui/`.

Lệnh Canvas (chỉ foreground):

- 37. `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (dùng `{"url":""}` hoặc `{"url":"/"}` để quay về scaffold mặc định). 38. `canvas.snapshot` trả về `{ format, base64 }` (mặc định `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` là alias legacy)

Lệnh camera (chỉ foreground; yêu cầu quyền):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Xem [Camera node](/nodes/camera) để biết tham số và công cụ CLI hỗ trợ.
