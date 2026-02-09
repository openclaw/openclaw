---
summary: "Khám phá node và các phương thức truyền tải (Bonjour, Tailscale, SSH) để tìm gateway"
read_when:
  - Triển khai hoặc thay đổi cơ chế khám phá/quảng bá Bonjour
  - Điều chỉnh các chế độ kết nối từ xa (trực tiếp so với SSH)
  - Thiết kế khám phá node + ghép cặp cho các node từ xa
title: "Khám phá và phương thức truyền tải"
---

# Khám phá & phương thức truyền tải

OpenClaw có hai vấn đề khác nhau nhưng trông khá giống nhau ở bề mặt:

1. **Điều khiển từ xa của người vận hành**: ứng dụng thanh menu macOS điều khiển một gateway chạy ở nơi khác.
2. **Ghép cặp node**: iOS/Android (và các node trong tương lai) tìm gateway và ghép cặp một cách an toàn.

Mục tiêu thiết kế là giữ toàn bộ việc khám phá/quảng bá mạng trong **Node Gateway** (`openclaw gateway`) và để các client (ứng dụng mac, iOS) chỉ đóng vai trò người tiêu thụ.

## Thuật ngữ

- Hầu hết các thiết lập dùng một gateway trên mỗi host; có thể thiết lập nhiều gateway cô lập. Bonjour hoạt động theo kiểu best-effort và không vượt qua các mạng.
- **Gateway WS (control plane)**: endpoint WebSocket trên `127.0.0.1:18789` theo mặc định; có thể bind vào LAN/tailnet qua `gateway.bind`.
- **Direct WS transport**: endpoint Gateway WS hướng LAN/tailnet (không dùng SSH).
- **SSH transport (fallback)**: điều khiển từ xa bằng cách chuyển tiếp `127.0.0.1:18789` qua SSH.
- **Legacy TCP bridge (deprecated/removed)**: phương thức truyền tải node cũ (xem [Bridge protocol](/gateway/bridge-protocol)); không còn được quảng bá để khám phá.

Chi tiết giao thức:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## Vì sao chúng tôi giữ cả “direct” và SSH

- **Direct WS** mang lại UX tốt nhất trong cùng mạng và trong tailnet:
  - tự động khám phá trên LAN qua Bonjour
  - token ghép cặp + ACLs do gateway sở hữu
  - không cần quyền truy cập shell; bề mặt giao thức có thể gọn và dễ kiểm toán
- **SSH** vẫn là phương án dự phòng phổ quát:
  - hoạt động ở bất cứ đâu bạn có quyền SSH (kể cả qua các mạng không liên quan)
  - vượt qua các vấn đề multicast/mDNS
  - không cần mở thêm cổng inbound nào ngoài SSH

## Đầu vào khám phá (cách client biết gateway ở đâu)

### 1. Bonjour / mDNS (chỉ LAN)

Bonjour là best-effort và không hoạt động xuyên qua các mạng. Với các thiết lập kiểu London/Vienna, Bonjour sẽ không giúp ích.

Hướng mục tiêu:

- **Gateway** quảng bá endpoint WS của mình qua Bonjour.
- Client duyệt và hiển thị danh sách “chọn một gateway”, sau đó lưu endpoint đã chọn.

Chi tiết xử lý sự cố và beacon: [Bonjour](/gateway/bonjour).

#### Chi tiết service beacon

- Loại dịch vụ:
  - `_openclaw-gw._tcp` (beacon truyền tải gateway)
- Khóa TXT (không bí mật):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (hoặc bất cứ giá trị nào được quảng bá)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (chỉ khi bật TLS)
  - `gatewayTlsSha256=<sha256>` (chỉ khi bật TLS và có fingerprint)
  - `canvasPort=18793` (cổng máy chủ canvas mặc định; phục vụ `/__openclaw__/canvas/`)
  - `cliPath=<path>` (tùy chọn; đường dẫn tuyệt đối tới entrypoint hoặc binary `openclaw` có thể chạy)
  - `tailnetDns=<magicdns>` (gợi ý tùy chọn; tự động phát hiện khi có Tailscale)

Tắt/ghi đè:

- `OPENCLAW_DISABLE_BONJOUR=1` tắt quảng bá.
- `gateway.bind` trong `~/.openclaw/openclaw.json` kiểm soát chế độ bind của Gateway.
- `OPENCLAW_SSH_PORT` ghi đè cổng SSH được quảng bá trong TXT (mặc định là 22).
- `OPENCLAW_TAILNET_DNS` xuất bản gợi ý `tailnetDns` (MagicDNS).
- `OPENCLAW_CLI_PATH` ghi đè đường dẫn CLI được quảng bá.

### 2. Tailnet (xuyên mạng)

Với các thiết lập kiểu London/Vienna, Bonjour sẽ không hữu ích. `openclaw doctor` là công cụ sửa chữa + di chuyển cho OpenClaw.

- Tên Tailscale MagicDNS (ưu tiên) hoặc một IP tailnet ổn định.

Nếu gateway có thể phát hiện nó đang chạy dưới Tailscale, nó sẽ công bố `tailnetDns` như một gợi ý tùy chọn cho client (bao gồm cả beacon diện rộng).

### 3. Mục tiêu thủ công / SSH

Khi không có tuyến direct (hoặc direct bị tắt), client luôn có thể kết nối qua SSH bằng cách chuyển tiếp cổng gateway trên local loopback.

Xem [Remote access](/gateway/remote).

## Lựa chọn phương thức truyền tải (chính sách client)

Hành vi client được khuyến nghị:

1. Nếu đã cấu hình một endpoint direct đã ghép cặp và có thể truy cập, hãy dùng nó.
2. Nếu không, nếu Bonjour tìm thấy một gateway trên LAN, cung cấp lựa chọn “Dùng gateway này” chỉ với một chạm và lưu nó làm endpoint direct.
3. Nếu không, nếu đã cấu hình DNS/IP tailnet, thử direct.
4. Nếu không, rơi về SSH.

## Ghép cặp + xác thực (phương thức direct)

Gateway là nguồn sự thật cho việc chấp nhận node/client.

- Yêu cầu ghép cặp được tạo/phê duyệt/từ chối trong gateway (xem [Gateway pairing](/gateway/pairing)).
- Gateway thực thi:
  - xác thực (token / cặp khóa)
  - phạm vi/ACLs (gateway không phải là proxy thô tới mọi phương thức)
  - giới hạn tốc độ

## Trách nhiệm theo từng thành phần

- **Gateway**: quảng bá beacon khám phá, quyết định ghép cặp, và lưu trữ endpoint WS.
- **Ứng dụng macOS**: giúp bạn chọn gateway, hiển thị lời nhắc ghép cặp, và chỉ dùng SSH như phương án dự phòng.
- **Node iOS/Android**: duyệt Bonjour như một tiện lợi và kết nối tới Gateway WS đã ghép cặp.
