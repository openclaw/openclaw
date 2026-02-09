---
summary: "Kế hoạch refactor: định tuyến exec host, phê duyệt node và runner không giao diện"
read_when:
  - Thiết kế định tuyến exec host hoặc phê duyệt exec
  - Triển khai node runner + IPC UI
  - Thêm các chế độ bảo mật exec host và slash command
title: "Refactor Exec Host"
---

# Kế hoạch refactor exec host

## Mục tiêu

- Thêm `exec.host` + `exec.security` để định tuyến thực thi qua **sandbox**, **gateway**, và **node**.
- Giữ mặc định **an toàn**: không thực thi chéo host trừ khi được bật rõ ràng.
- Tách việc thực thi thành một **dịch vụ runner không giao diện** với UI tùy chọn (ứng dụng macOS) thông qua IPC cục bộ.
- Cung cấp chính sách **theo từng tác tử**, danh sách cho phép, chế độ hỏi, và ràng buộc node.
- Hỗ trợ **các chế độ hỏi** hoạt động _có_ hoặc _không_ có danh sách cho phép.
- Đa nền tảng: Unix socket + xác thực bằng token (đồng nhất macOS/Linux/Windows).

## Không nằm trong phạm vi

- Không migrate danh sách cho phép cũ hoặc hỗ trợ schema cũ.
- Không PTY/streaming cho exec trên node (chỉ đầu ra tổng hợp).
- Không có lớp mạng mới ngoài Bridge + Gateway hiện có.

## Quyết định (đã khóa)

- **Khóa cấu hình:** `exec.host` + `exec.security` (cho phép ghi đè theo từng tác tử).
- **Nâng quyền:** giữ `/elevated` như một alias cho quyền truy cập đầy đủ của gateway.
- **Mặc định hỏi:** `on-miss`.
- **Kho phê duyệt:** `~/.openclaw/exec-approvals.json` (JSON, không migrate legacy).
- **Runner:** dịch vụ hệ thống không giao diện; ứng dụng UI host một Unix socket cho phê duyệt.
- **Danh tính node:** dùng `nodeId` hiện có.
- **Xác thực socket:** Unix socket + token (đa nền tảng); tách sau nếu cần.
- **Trạng thái host node:** `~/.openclaw/node.json` (node id + pairing token).
- **Exec host macOS:** chạy `system.run` bên trong ứng dụng macOS; dịch vụ host node chuyển tiếp yêu cầu qua IPC cục bộ.
- **Không dùng XPC helper:** giữ Unix socket + token + kiểm tra peer.

## Khái niệm chính

### Host

- `sandbox`: Docker exec (hành vi hiện tại).
- `gateway`: exec trên máy chủ gateway.
- `node`: exec trên node runner qua Bridge (`system.run`).

### Chế độ bảo mật

- `deny`: luôn chặn.
- `allowlist`: chỉ cho phép các khớp.
- `full`: cho phép mọi thứ (tương đương nâng quyền).

### Chế độ hỏi

- `off`: không bao giờ hỏi.
- `on-miss`: chỉ hỏi khi danh sách cho phép không khớp.
- `always`: hỏi mọi lần.

Hỏi **độc lập** với danh sách cho phép; danh sách cho phép có thể dùng với `always` hoặc `on-miss`.

### Giải quyết chính sách (theo từng exec)

1. Giải quyết `exec.host` (tham số tool → ghi đè theo tác tử → mặc định toàn cục).
2. Giải quyết `exec.security` và `exec.ask` (cùng thứ tự ưu tiên).
3. Nếu host là `sandbox`, tiếp tục exec sandbox cục bộ.
4. Nếu host là `gateway` hoặc `node`, áp dụng chính sách bảo mật + hỏi trên host đó.

## An toàn mặc định

- Mặc định `exec.host = sandbox`.
- Mặc định `exec.security = deny` cho `gateway` và `node`.
- Mặc định `exec.ask = on-miss` (chỉ liên quan nếu bảo mật cho phép).
- Nếu không đặt ràng buộc node, **tác tử có thể nhắm tới bất kỳ node nào**, nhưng chỉ khi chính sách cho phép.

## Bề mặt cấu hình

### Tham số tool

- `exec.host` (tùy chọn): `sandbox | gateway | node`.
- `exec.security` (tùy chọn): `deny | allowlist | full`.
- `exec.ask` (tùy chọn): `off | on-miss | always`.
- `exec.node` (tùy chọn): node id/tên để dùng khi `host=node`.

### Khóa cấu hình (toàn cục)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (ràng buộc node mặc định)

### Khóa cấu hình (theo tác tử)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = đặt `tools.exec.host=gateway`, `tools.exec.security=full` cho phiên tác tử.
- `/elevated off` = khôi phục cài đặt exec trước đó cho phiên tác tử.

## Kho phê duyệt (JSON)

Đường dẫn: `~/.openclaw/exec-approvals.json`

Mục đích:

- Chính sách cục bộ + danh sách cho phép cho **host thực thi** (gateway hoặc node runner).
- Cơ chế hỏi dự phòng khi không có UI.
- Thông tin xác thực IPC cho các client UI.

Schema đề xuất (v1):

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

Ghi chú:

- Không hỗ trợ định dạng danh sách cho phép legacy.
- `askFallback` chỉ áp dụng khi `ask` là bắt buộc và không có UI khả dụng.
- Quyền file: `0600`.

## Dịch vụ runner (không giao diện)

### Vai trò

- Thực thi cục bộ `exec.security` + `exec.ask`.
- Thực thi lệnh hệ thống và trả về đầu ra.
- Phát sự kiện Bridge cho vòng đời exec (tùy chọn nhưng khuyến nghị).

### Vòng đời dịch vụ

- Launchd/daemon trên macOS; dịch vụ hệ thống trên Linux/Windows.
- JSON phê duyệt là cục bộ với host thực thi.
- UI host một Unix socket cục bộ; runner kết nối theo nhu cầu.

## Tích hợp UI (ứng dụng macOS)

### IPC

- Unix socket tại `~/.openclaw/exec-approvals.sock` (0600).
- Token lưu tại `exec-approvals.json` (0600).
- Kiểm tra peer: chỉ cùng UID.
- Challenge/response: nonce + HMAC(token, request-hash) để ngăn replay.
- TTL ngắn (ví dụ 10s) + giới hạn payload + giới hạn tốc độ.

### Luồng hỏi (exec host trong ứng dụng macOS)

1. Dịch vụ node nhận `system.run` từ gateway.
2. Dịch vụ node kết nối socket cục bộ và gửi prompt/yêu cầu exec.
3. Ứng dụng xác thực peer + token + HMAC + TTL, sau đó hiển thị hộp thoại nếu cần.
4. Ứng dụng thực thi lệnh trong ngữ cảnh UI và trả về đầu ra.
5. Dịch vụ node trả đầu ra về gateway.

Nếu thiếu UI:

- Áp dụng `askFallback` (`deny|allowlist|full`).

### Sơ đồ (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Danh tính node + ràng buộc

- Dùng `nodeId` hiện có từ Bridge pairing.
- Mô hình ràng buộc:
  - `tools.exec.node` giới hạn tác tử vào một node cụ thể.
  - Nếu không đặt, tác tử có thể chọn bất kỳ node nào (chính sách vẫn áp dụng mặc định).
- Giải quyết chọn node:
  - `nodeId` khớp chính xác
  - `displayName` (chuẩn hóa)
  - `remoteIp`
  - `nodeId` tiền tố (>= 6 ký tự)

## Sự kiện

### Ai thấy sự kiện

- Sự kiện hệ thống là **theo phiên** và được hiển thị cho tác tử ở prompt tiếp theo.
- Lưu trong hàng đợi bộ nhớ của gateway (`enqueueSystemEvent`).

### Nội dung sự kiện

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + phần đuôi đầu ra tùy chọn
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Vận chuyển

Tùy chọn A (khuyến nghị):

- Runner gửi các frame Bridge `event` `exec.started` / `exec.finished`.
- Gateway `handleBridgeEvent` ánh xạ chúng thành `enqueueSystemEvent`.

Tùy chọn B:

- Tool `exec` của gateway xử lý vòng đời trực tiếp (chỉ đồng bộ).

## Luồng exec

### Host sandbox

- Hành vi `exec` hiện có (Docker hoặc host khi không sandbox).
- Chỉ hỗ trợ PTY ở chế độ không sandbox.

### Host gateway

- Tiến trình Gateway thực thi trên chính máy của nó.
- Thực thi `exec-approvals.json` cục bộ (bảo mật/hỏi/danh sách cho phép).

### Host node

- Gateway gọi `node.invoke` với `system.run`.
- Runner thực thi phê duyệt cục bộ.
- Runner trả về stdout/stderr đã tổng hợp.
- Tùy chọn sự kiện Bridge cho bắt đầu/kết thúc/từ chối.

## Giới hạn đầu ra

- Giới hạn stdout+stderr kết hợp ở **200k**; giữ **đuôi 20k** cho sự kiện.
- Truncate with a clear suffix (e.g., `"… (truncated)"`).

## Slash command

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Ghi đè theo tác tử, theo phiên; không lưu trừ khi được lưu qua cấu hình.
- `/elevated on|off|ask|full` vẫn là lối tắt cho `host=gateway security=full` (với `full` bỏ qua phê duyệt).

## Câu chuyện đa nền tảng

- Dịch vụ runner là mục tiêu thực thi có thể mang đi.
- UI là tùy chọn; nếu thiếu, áp dụng `askFallback`.
- Windows/Linux hỗ trợ cùng JSON phê duyệt + giao thức socket.

## Các giai đoạn triển khai

### Giai đoạn 1: cấu hình + định tuyến exec

- Thêm schema cấu hình cho `exec.host`, `exec.security`, `exec.ask`, `exec.node`.
- Cập nhật plumbing tool để tôn trọng `exec.host`.
- Thêm slash command `/exec` và giữ alias `/elevated`.

### Giai đoạn 2: kho phê duyệt + thực thi tại gateway

- Triển khai reader/writer `exec-approvals.json`.
- Thực thi danh sách cho phép + chế độ hỏi cho host `gateway`.
- Thêm giới hạn đầu ra.

### Giai đoạn 3: thực thi tại node runner

- Cập nhật node runner để thực thi danh sách cho phép + hỏi.
- Thêm cầu nối prompt qua Unix socket tới UI ứng dụng macOS.
- Kết nối `askFallback`.

### Giai đoạn 4: sự kiện

- Thêm sự kiện Bridge từ node → gateway cho vòng đời exec.
- Ánh xạ sang `enqueueSystemEvent` cho prompt của tác tử.

### Giai đoạn 5: hoàn thiện UI

- Ứng dụng Mac: trình chỉnh sửa danh sách cho phép, bộ chuyển theo tác tử, UI chính sách hỏi.
- Điều khiển ràng buộc node (tùy chọn).

## Kế hoạch kiểm thử

- Unit test: khớp danh sách cho phép (glob + không phân biệt hoa thường).
- Unit test: thứ tự ưu tiên giải quyết chính sách (tham số tool → ghi đè theo tác tử → toàn cục).
- Integration test: luồng deny/allow/ask của node runner.
- Test sự kiện Bridge: sự kiện node → định tuyến sự kiện hệ thống.

## Rủi ro mở

- UI không khả dụng: đảm bảo `askFallback` được tôn trọng.
- Lệnh chạy lâu: dựa vào timeout + giới hạn đầu ra.
- Mơ hồ đa node: báo lỗi trừ khi có ràng buộc node hoặc tham số node rõ ràng.

## Tài liệu liên quan

- [Exec tool](/tools/exec)
- [Phê duyệt exec](/tools/exec-approvals)
- [Nodes](/nodes)
- [Chế độ nâng quyền](/tools/elevated)
