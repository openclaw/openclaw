---
summary: "Quyền truy cập và xác thực dashboard Gateway (Control UI)"
read_when:
  - Thay đổi xác thực dashboard hoặc các chế độ phơi bày
title: "Dashboard"
---

# Dashboard (Control UI)

Dashboard của Gateway là Control UI trên trình duyệt, được phục vụ mặc định tại `/`
(có thể ghi đè bằng `gateway.controlUi.basePath`).

Mở nhanh (Gateway cục bộ):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (hoặc [http://localhost:18789/](http://localhost:18789/))

Tài liệu tham khảo chính:

- [Control UI](/web/control-ui) để biết cách sử dụng và các khả năng của UI.
- [Tailscale](/gateway/tailscale) cho tự động hóa Serve/Funnel.
- [Web surfaces](/web) cho các chế độ bind và ghi chú bảo mật.

Xác thực được thực thi tại bước bắt tay WebSocket thông qua `connect.params.auth`
(token hoặc password). Xem `gateway.auth` trong [Cấu hình Gateway](/gateway/configuration).

30. Lưu ý bảo mật: Control UI là một **bề mặt quản trị** (chat, cấu hình, phê duyệt exec).
31. Không công khai nó. 32. UI lưu token trong `localStorage` sau lần tải đầu tiên.
32. Ưu tiên localhost, Tailscale Serve hoặc một đường hầm SSH.

## Fast path (khuyến nghị)

- Sau khi hoàn tất hướng dẫn ban đầu, CLI tự động mở dashboard và in ra một liên kết sạch (không kèm token).
- Mở lại bất cứ lúc nào: `openclaw dashboard` (sao chép liên kết, mở trình duyệt nếu có thể, hiển thị gợi ý SSH nếu chạy headless).
- Nếu UI yêu cầu xác thực, dán token từ `gateway.auth.token` (hoặc `OPENCLAW_GATEWAY_TOKEN`) vào cài đặt Control UI.

## Cơ bản về token (cục bộ vs từ xa)

- **Localhost**: mở `http://127.0.0.1:18789/`.
- **Nguồn token**: `gateway.auth.token` (hoặc `OPENCLAW_GATEWAY_TOKEN`); UI lưu một bản sao trong localStorage sau khi bạn kết nối.
- 34. **Không phải localhost**: sử dụng Tailscale Serve (không cần token nếu `gateway.auth.allowTailscale: true`), bind tailnet với token, hoặc một đường hầm SSH. See [Web surfaces](/web).

## Nếu bạn thấy “unauthorized” / 1008

- Đảm bảo gateway có thể truy cập được (cục bộ: `openclaw status`; từ xa: đường hầm SSH `ssh -N -L 18789:127.0.0.1:18789 user@host` rồi mở `http://127.0.0.1:18789/`).
- Lấy token từ máy chủ gateway: `openclaw config get gateway.auth.token` (hoặc tạo mới: `openclaw doctor --generate-gateway-token`).
- Trong cài đặt dashboard, dán token vào trường xác thực, sau đó kết nối.
