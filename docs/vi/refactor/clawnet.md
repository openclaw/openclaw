---
summary: "Tái cấu trúc Clawnet: hợp nhất giao thức mạng, vai trò, xác thực, phê duyệt, định danh"
read_when:
  - Lập kế hoạch một giao thức mạng thống nhất cho các node + client của operator
  - Làm lại phê duyệt, ghép cặp, TLS và hiện diện trên các thiết bị
title: "Tái cấu trúc Clawnet"
---

# Tái cấu trúc Clawnet (hợp nhất giao thức + xác thực)

## Chào

Chào Peter — hướng đi rất đúng; điều này mở ra UX đơn giản hơn + bảo mật mạnh hơn.

## Mục đích

Một tài liệu chặt chẽ, duy nhất cho:

- Trạng thái hiện tại: giao thức, luồng, ranh giới tin cậy.
- Điểm đau: phê duyệt, định tuyến nhiều chặng, trùng lặp UI.
- Trạng thái mới đề xuất: một giao thức, vai trò có phạm vi, xác thực/ghép cặp hợp nhất, ghim TLS.
- Mô hình định danh: ID ổn định + slug dễ thương.
- Kế hoạch di trú, rủi ro, câu hỏi mở.

## Mục tiêu (từ thảo luận)

- Một giao thức cho tất cả client (app mac, CLI, iOS, Android, node không giao diện).
- Mọi thành phần mạng đều được xác thực + ghép cặp.
- Rõ ràng vai trò: node vs operator.
- Phê duyệt tập trung, được chuyển tới nơi người dùng đang ở.
- Mã hóa TLS + ghim tùy chọn cho mọi lưu lượng từ xa.
- Giảm thiểu trùng lặp mã.
- Một máy chỉ xuất hiện một lần (không trùng mục UI/node).

## Không phải mục tiêu (nêu rõ)

- Loại bỏ phân tách năng lực (vẫn cần nguyên tắc đặc quyền tối thiểu).
- Mở toàn bộ control plane của gateway mà không kiểm tra phạm vi.
- Làm cho xác thực phụ thuộc vào nhãn do con người đặt (slug không dùng cho bảo mật).

---

# Trạng thái hiện tại (as‑is)

## Hai giao thức

### 1. Gateway WebSocket (control plane)

- Bề mặt API đầy đủ: cấu hình, kênh, mô hình, phiên, chạy agent, log, node, v.v.
- 48. Liên kết mặc định: loopback. 49. Truy cập từ xa qua SSH/Tailscale.
- Xác thực: token/mật khẩu qua `connect`.
- Không có ghim TLS (phụ thuộc loopback/đường hầm).
- Mã:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (vận chuyển node)

- Bề mặt allowlist hẹp, định danh node + ghép cặp.
- JSONL qua TCP; TLS tùy chọn + ghim dấu vân tay chứng chỉ.
- TLS quảng bá dấu vân tay trong TXT khám phá.
- Mã:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Client control plane hiện nay

- CLI → Gateway WS qua `callGateway` (`src/gateway/call.ts`).
- UI app macOS → Gateway WS (`GatewayConnection`).
- Web Control UI → Gateway WS.
- ACP → Gateway WS.
- Điều khiển trên trình duyệt dùng máy chủ HTTP control riêng.

## Node hiện nay

- App macOS ở chế độ node kết nối tới bridge của Gateway (`MacNodeBridgeSession`).
- App iOS/Android kết nối tới bridge của Gateway.
- Ghép cặp + token theo từng node được lưu trên gateway.

## Luồng phê duyệt hiện tại (exec)

- Agent dùng `system.run` qua Gateway.
- Gateway gọi node qua bridge.
- Runtime của node quyết định phê duyệt.
- Hộp thoại UI hiển thị bởi app mac (khi node == app mac).
- Node trả `invoke-res` về Gateway.
- Nhiều chặng, UI gắn với máy chủ node.

## Hiện diện + định danh hiện nay

- Bản ghi hiện diện Gateway từ các client WS.
- Bản ghi hiện diện node từ bridge.
- App mac có thể hiển thị hai mục cho cùng một máy (UI + node).
- Định danh node lưu trong kho ghép cặp; định danh UI tách biệt.

---

# Vấn đề / điểm đau

- Hai ngăn xếp giao thức cần duy trì (WS + Bridge).
- Phê duyệt trên node từ xa: hộp thoại xuất hiện ở máy chạy node, không phải nơi người dùng đang ở.
- Ghim TLS chỉ có ở bridge; WS phụ thuộc SSH/Tailscale.
- Trùng lặp định danh: cùng một máy xuất hiện như nhiều instance.
- Vai trò mơ hồ: năng lực của UI + node + CLI chưa tách bạch rõ.

---

# Trạng thái mới đề xuất (Clawnet)

## Một giao thức, hai vai trò

Một giao thức WS duy nhất với vai trò + phạm vi.

- **Vai trò: node** (máy chủ năng lực)
- **Vai trò: operator** (control plane)
- **Phạm vi** tùy chọn cho operator:
  - `operator.read` (trạng thái + xem)
  - `operator.write` (chạy agent, gửi)
  - `operator.admin` (cấu hình, kênh, mô hình)

### Hành vi theo vai trò

**Node**

- Có thể đăng ký năng lực (`caps`, `commands`, quyền).
- Có thể nhận lệnh `invoke` (`system.run`, `camera.*`, `canvas.*`, `screen.record`, v.v.).
- Có thể gửi sự kiện: `voice.transcript`, `agent.request`, `chat.subscribe`.
- Không thể gọi các API control plane về config/models/channels/sessions/agent.

**Operator**

- Toàn bộ API control plane, bị chặn theo phạm vi.
- Nhận mọi phê duyệt.
- Không trực tiếp thực thi hành động OS; định tuyến tới node.

### Quy tắc then chốt

50. Vai trò áp dụng theo từng kết nối, không theo từng thiết bị. Một thiết bị có thể mở cả hai vai trò, một cách tách biệt.

---

# Xác thực + ghép cặp hợp nhất

## Định danh client

Mỗi client cung cấp:

- `deviceId` (ổn định, suy ra từ khóa thiết bị).
- `displayName` (tên hiển thị cho con người).
- `role` + `scope` + `caps` + `commands`.

## Luồng ghép cặp (hợp nhất)

- Client kết nối chưa xác thực.
- Gateway tạo **yêu cầu ghép cặp** cho `deviceId` đó.
- Operator nhận prompt; chấp thuận/từ chối.
- Gateway cấp thông tin xác thực gắn với:
  - khóa công khai của thiết bị
  - vai trò
  - phạm vi
  - năng lực/lệnh
- Client lưu token, kết nối lại với xác thực.

## Xác thực gắn với thiết bị (tránh phát lại bearer token)

Ưu tiên: cặp khóa theo thiết bị.

- Thiết bị tạo cặp khóa một lần.
- `deviceId = fingerprint(publicKey)`.
- Gateway gửi nonce; thiết bị ký; gateway xác minh.
- Token được cấp cho khóa công khai (bằng chứng sở hữu), không phải chuỗi.

Phương án khác:

- mTLS (chứng chỉ client): mạnh nhất, phức tạp vận hành hơn.
- Bearer token ngắn hạn chỉ dùng tạm thời (xoay vòng + thu hồi sớm).

## Phê duyệt im lặng (heuristic SSH)

Define it precisely to avoid a weak link. Ưu tiên một lựa chọn:

- **Chỉ cục bộ**: tự ghép cặp khi client kết nối qua loopback/Unix socket.
- **Thử thách qua SSH**: gateway phát nonce; client chứng minh SSH bằng cách lấy nó.
- **Cửa sổ hiện diện vật lý**: sau một phê duyệt cục bộ trên UI máy chủ gateway, cho phép tự ghép cặp trong thời gian ngắn (vd. 10 phút).

Luôn ghi log + lưu lại các phê duyệt tự động.

---

# TLS ở mọi nơi (dev + prod)

## Tái sử dụng TLS hiện có của bridge

Dùng runtime TLS hiện tại + ghim dấu vân tay:

- `src/infra/bridge/server/tls.ts`
- logic xác minh dấu vân tay trong `src/node-host/bridge-client.ts`

## Áp dụng cho WS

- Máy chủ WS hỗ trợ TLS với cùng cert/key + dấu vân tay.
- Client WS có thể ghim dấu vân tay (tùy chọn).
- Discovery quảng bá TLS + dấu vân tay cho mọi endpoint.
  - Discovery chỉ là gợi ý định vị; không bao giờ là neo tin cậy.

## Lý do

- Giảm phụ thuộc vào SSH/Tailscale cho tính bảo mật.
- Làm cho kết nối di động từ xa an toàn theo mặc định.

---

# Thiết kế lại phê duyệt (tập trung)

## Hiện tại

Approval happens on node host (mac app node runtime). Lời nhắc xuất hiện tại nơi node đang chạy.

## Đề xuất

Phê duyệt được **lưu trữ tại gateway**, UI được phân phối tới các client operator.

### Luồng mới

1. Gateway nhận ý định `system.run` (agent).
2. Gateway tạo bản ghi phê duyệt: `approval.requested`.
3. UI operator hiển thị prompt.
4. Quyết định phê duyệt gửi về gateway: `approval.resolve`.
5. Gateway gọi lệnh node nếu được chấp thuận.
6. Node thực thi, trả `invoke-res`.

### Ngữ nghĩa phê duyệt (tăng cường)

- Phát tới tất cả operator; chỉ UI đang hoạt động hiển thị modal (các UI khác nhận toast).
- Quyết định đầu tiên có hiệu lực; gateway từ chối các lần sau vì đã được xử lý.
- Timeout mặc định: từ chối sau N giây (vd. 60s), ghi log lý do.
- Việc xử lý yêu cầu phạm vi `operator.approvals`.

## Lợi ích

- Prompt xuất hiện nơi người dùng đang ở (mac/điện thoại).
- Phê duyệt nhất quán cho node từ xa.
- Runtime node giữ headless; không phụ thuộc UI.

---

# Ví dụ làm rõ vai trò

## App iPhone

- **Vai trò node** cho: mic, camera, voice chat, vị trí, push‑to‑talk.
- **operator.read** tùy chọn cho trạng thái và xem chat.
- **operator.write/admin** tùy chọn chỉ khi bật rõ ràng.

## App macOS

- Vai trò operator theo mặc định (UI điều khiển).
- Vai trò node khi bật “Mac node” (system.run, màn hình, camera).
- Cùng deviceId cho cả hai kết nối → gộp thành một mục UI.

## CLI

- Luôn là vai trò operator.
- Phạm vi suy ra theo lệnh con:
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - phê duyệt + ghép cặp → `operator.approvals` / `operator.pairing`

---

# Định danh + slug

## ID ổn định

Bắt buộc cho xác thực; không bao giờ thay đổi.
Ưu tiên:

- Dấu vân tay cặp khóa (hash khóa công khai).

## Slug dễ thương (chủ đề tôm hùm)

Chỉ là nhãn cho con người.

- Ví dụ: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Lưu trong registry của gateway, có thể chỉnh sửa.
- Xử lý trùng: `-2`, `-3`.

## Nhóm UI

Cùng `deviceId` trên các vai trò → một dòng “Instance” duy nhất:

- Huy hiệu: `operator`, `node`.
- Hiển thị năng lực + lần thấy gần nhất.

---

# Chiến lược di trú

## Giai đoạn 0: Tài liệu + thống nhất

- Công bố tài liệu này.
- Kiểm kê mọi lời gọi giao thức + luồng phê duyệt.

## Giai đoạn 1: Thêm vai trò/phạm vi cho WS

- Mở rộng tham số `connect` với `role`, `scope`, `deviceId`.
- Thêm chặn allowlist cho vai trò node.

## Giai đoạn 2: Tương thích Bridge

- Giữ bridge chạy.
- Thêm hỗ trợ node qua WS song song.
- Khóa tính năng sau cờ cấu hình.

## Giai đoạn 3: Phê duyệt tập trung

- Thêm sự kiện yêu cầu phê duyệt + xử lý trong WS.
- Cập nhật UI app mac để hiển thị prompt + phản hồi.
- Runtime node ngừng hiển thị UI.

## Giai đoạn 4: Hợp nhất TLS

- Thêm cấu hình TLS cho WS dùng runtime TLS của bridge.
- Thêm ghim cho client.

## Giai đoạn 5: Ngừng bridge

- Di trú iOS/Android/mac node sang WS.
- Giữ bridge làm phương án dự phòng; loại bỏ khi ổn định.

## Giai đoạn 6: Xác thực gắn thiết bị

- Yêu cầu định danh dựa trên khóa cho mọi kết nối không cục bộ.
- Thêm UI thu hồi + xoay vòng.

---

# Ghi chú bảo mật

- Vai trò/allowlist được thực thi tại ranh giới gateway.
- Không client nào có API “đầy đủ” nếu không có phạm vi operator.
- Ghép cặp bắt buộc cho _mọi_ kết nối.
- TLS + ghim giảm rủi ro MITM cho di động.
- Phê duyệt im lặng qua SSH là tiện ích; vẫn được ghi lại + có thể thu hồi.
- Discovery không bao giờ là neo tin cậy.
- Khai báo năng lực được xác minh với allowlist phía máy chủ theo nền tảng/loại.

# Streaming + payload lớn (media của node)

Control plane WS ổn cho thông điệp nhỏ, nhưng node còn làm:

- clip camera
- ghi màn hình
- luồng âm thanh

Tùy chọn:

1. Khung nhị phân WS + chia khối + quy tắc backpressure.
2. Endpoint streaming riêng (vẫn TLS + xác thực).
3. Giữ bridge lâu hơn cho lệnh nặng media, di trú sau cùng.

Chọn một trước khi triển khai để tránh lệch hướng.

# Chính sách năng lực + lệnh

- Năng lực/lệnh do node báo cáo được coi là **khai báo**.
- Gateway thực thi allowlist theo nền tảng.
- Mọi lệnh mới cần phê duyệt operator hoặc thay đổi allowlist rõ ràng.
- Audit thay đổi kèm dấu thời gian.

# Audit + giới hạn tốc độ

- Log: yêu cầu ghép cặp, phê duyệt/từ chối, cấp/xoay vòng/thu hồi token.
- Giới hạn tốc độ spam ghép cặp và prompt phê duyệt.

# Vệ sinh giao thức

- Phiên bản giao thức + mã lỗi rõ ràng.
- Quy tắc reconnect + chính sách heartbeat.
- TTL hiện diện và ngữ nghĩa last‑seen.

---

# Câu hỏi mở

1. Một thiết bị chạy cả hai vai trò: mô hình token
   - Khuyến nghị token tách biệt theo vai trò (node vs operator).
   - Cùng deviceId; phạm vi khác nhau; thu hồi rõ ràng hơn.

2. Độ chi tiết phạm vi operator
   - read/write/admin + phê duyệt + ghép cặp (tối thiểu khả thi).
   - Cân nhắc phạm vi theo tính năng sau.

3. UX xoay vòng + thu hồi token
   - Tự xoay khi đổi vai trò.
   - UI thu hồi theo deviceId + vai trò.

4. Discovery
   - Mở rộng TXT Bonjour hiện tại để bao gồm dấu vân tay TLS của WS + gợi ý vai trò.
   - Chỉ coi là gợi ý định vị.

5. Phê duyệt xuyên mạng
   - Phát tới mọi client operator; UI đang hoạt động hiển thị modal.
   - Phản hồi đầu tiên thắng; gateway đảm bảo tính nguyên tử.

---

# Tóm tắt (TL;DR)

- Hiện tại: control plane WS + vận chuyển node bằng Bridge.
- Điểm đau: phê duyệt + trùng lặp + hai ngăn xếp.
- Đề xuất: một giao thức WS với vai trò + phạm vi rõ ràng, ghép cặp hợp nhất + ghim TLS, phê duyệt do gateway lưu trữ, ID thiết bị ổn định + slug dễ thương.
- Kết quả: UX đơn giản hơn, bảo mật mạnh hơn, ít trùng lặp, định tuyến di động tốt hơn.
