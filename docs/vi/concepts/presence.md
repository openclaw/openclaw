---
summary: "Cách các mục presence của OpenClaw được tạo ra, hợp nhất và hiển thị"
read_when:
  - Gỡ lỗi tab Instances
  - Điều tra các dòng instance bị trùng lặp hoặc lỗi thời
  - Thay đổi kết nối WS của gateway hoặc các beacon sự kiện hệ thống
title: "Presence"
---

# Presence

“Presence” của OpenClaw là một góc nhìn nhẹ, theo kiểu best‑effort về:

- chính **Gateway**, và
- **các client kết nối tới Gateway** (ứng dụng mac, WebChat, CLI, v.v.)

Presence chủ yếu được dùng để hiển thị tab **Instances** của ứng dụng macOS và
cung cấp khả năng quan sát nhanh cho người vận hành.

## Các trường presence (những gì được hiển thị)

Các mục presence là các đối tượng có cấu trúc với các trường như:

- `instanceId` (tùy chọn nhưng rất khuyến nghị): định danh client ổn định (thường là `connect.client.instanceId`)
- `host`: tên máy chủ thân thiện với người dùng
- `ip`: địa chỉ IP theo kiểu best‑effort
- `version`: chuỗi phiên bản client
- `deviceFamily` / `modelIdentifier`: gợi ý phần cứng
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: “số giây kể từ lần có thao tác người dùng gần nhất” (nếu biết)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: dấu thời gian cập nhật lần cuối (ms kể từ epoch)

## Nguồn tạo (presence đến từ đâu)

Các mục presence được tạo bởi nhiều nguồn và được **hợp nhất**.

### 1. Mục tự thân của Gateway

Gateway luôn khởi tạo một mục “self” khi khởi động để các UI hiển thị máy chủ gateway
ngay cả trước khi có client nào kết nối.

### 2. Kết nối WebSocket

Mỗi WS client đều bắt đầu bằng một yêu cầu `connect`. 17. Khi bắt tay thành công, the
Gateway upsert một bản ghi presence cho kết nối đó.

#### Vì sao các lệnh CLI một‑lần không xuất hiện

18. CLI thường kết nối cho các lệnh ngắn, dùng một lần. Để tránh spam danh sách Instances, `client.mode === "cli"` sẽ **không** được chuyển thành một mục presence.

### 3. Beacon `system-event`

20. Client có thể gửi các beacon định kỳ phong phú hơn qua phương thức `system-event`. Ứng dụng mac sử dụng điều này để báo cáo tên máy chủ, IP và `lastInputSeconds`.

### 4. Node kết nối (vai trò: node)

Khi một node kết nối qua Gateway WebSocket với `role: node`, Gateway sẽ upsert
một mục presence cho node đó (luồng giống các client WS khác).

## Quy tắc hợp nhất + khử trùng lặp (vì sao `instanceId` quan trọng)

Các mục presence được lưu trong một map trong bộ nhớ duy nhất:

- Các mục được khóa theo một **presence key**.
- Khóa tốt nhất là một `instanceId` ổn định (từ `connect.client.instanceId`) có thể tồn tại qua các lần khởi động lại.
- Khóa không phân biệt chữ hoa/chữ thường.

Nếu một client kết nối lại mà không có `instanceId` ổn định, nó có thể xuất hiện
thành một dòng **trùng lặp**.

## TTL và kích thước giới hạn

Presence được thiết kế là tạm thời:

- **TTL:** các mục cũ hơn 5 phút sẽ bị loại bỏ
- **Số mục tối đa:** 200 (loại bỏ mục cũ nhất trước)

Điều này giúp danh sách luôn mới và tránh tăng trưởng bộ nhớ không giới hạn.

## Lưu ý về kết nối từ xa/đường hầm (IP loopback)

22. Khi một client kết nối qua đường hầm SSH / chuyển tiếp cổng cục bộ, Gateway có thể
    thấy địa chỉ từ xa là `127.0.0.1`. 23. Để tránh ghi đè một IP tốt do client báo cáo,
    địa chỉ loopback từ xa sẽ bị bỏ qua.

## Bên sử dụng

### Tab Instances trên macOS

Ứng dụng macOS hiển thị đầu ra của `system-presence` và áp dụng một chỉ báo trạng thái nhỏ
(Active/Idle/Stale) dựa trên tuổi của lần cập nhật gần nhất.

## Mẹo gỡ lỗi

- Để xem danh sách thô, hãy gọi `system-presence` tới Gateway.
- Nếu bạn thấy trùng lặp:
  - xác nhận client gửi một `client.instanceId` ổn định trong quá trình bắt tay
  - xác nhận các beacon định kỳ dùng cùng `instanceId`
  - kiểm tra xem mục phát sinh từ kết nối có thiếu `instanceId` hay không (trùng lặp là điều được dự đoán)
