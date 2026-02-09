---
summary: "Chạy nhiều OpenClaw Gateway trên một máy chủ (cách ly, cổng và hồ sơ)"
read_when:
  - Chạy nhiều hơn một Gateway trên cùng một máy
  - Bạn cần cấu hình/trạng thái/cổng được cách ly cho từng Gateway
title: "Nhiều Gateway"
---

# Nhiều Gateway (cùng máy chủ)

Hầu hết các thiết lập nên dùng một Gateway vì một Gateway có thể xử lý nhiều kết nối nhắn tin và agent. Nếu bạn cần cách ly hoặc dự phòng mạnh hơn (ví dụ: bot cứu hộ), hãy chạy các Gateway riêng với hồ sơ/cổng tách biệt.

## Danh sách kiểm tra cách ly (bắt buộc)

- `OPENCLAW_CONFIG_PATH` — tệp cấu hình theo từng instance
- `OPENCLAW_STATE_DIR` — phiên, thông tin xác thực, bộ nhớ đệm theo từng instance
- `agents.defaults.workspace` — thư mục gốc workspace theo từng instance
- `gateway.port` (hoặc `--port`) — duy nhất cho mỗi instance
- Các cổng dẫn xuất (browser/canvas) không được trùng lặp

Nếu các mục này bị dùng chung, bạn sẽ gặp xung đột cấu hình và va chạm cổng.

## Khuyến nghị: profiles (`--profile`)

Profiles tự động phạm vi hóa `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` và thêm hậu tố vào tên dịch vụ.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Dịch vụ theo từng profile:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Hướng dẫn bot cứu hộ

Chạy Gateway thứ hai trên cùng máy chủ với các thành phần riêng:

- profile/cấu hình
- thư mục trạng thái
- workspace
- cổng cơ sở (cùng các cổng dẫn xuất)

Điều này giúp bot cứu hộ được cách ly khỏi bot chính để có thể gỡ lỗi hoặc áp dụng thay đổi cấu hình khi bot chính ngừng hoạt động.

Khoảng cách cổng: chừa ít nhất 20 cổng giữa các cổng cơ sở để các cổng browser/canvas/CDP dẫn xuất không bao giờ trùng nhau.

### Cách cài đặt (bot cứu hộ)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## Ánh xạ cổng (dẫn xuất)

Cổng cơ sở = `gateway.port` (hoặc `OPENCLAW_GATEWAY_PORT` / `--port`).

- cổng dịch vụ điều khiển trình duyệt = cổng cơ sở + 2 (chỉ local loopback)
- `canvasHost.port = base + 4`
- Các cổng CDP hồ sơ trình duyệt tự động cấp phát từ `browser.controlPort + 9 ..` + 108\`

Nếu bạn ghi đè bất kỳ mục nào trong cấu hình hoặc biến môi trường, bạn phải giữ chúng là duy nhất cho từng instance.

## Ghi chú Browser/CDP (bẫy thường gặp)

- **Không** cố định `browser.cdpUrl` cùng một giá trị trên nhiều instance.
- Mỗi instance cần cổng điều khiển trình duyệt và dải CDP riêng (dẫn xuất từ cổng gateway của nó).
- Nếu cần cổng CDP cố định, đặt `browser.profiles.<name>`.cdpPort\` cho mỗi instance.
- Chrome từ xa: dùng `browser.profiles.<name>``.cdpUrl` (theo hồ sơ, theo instance).

## Ví dụ env thủ công

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Kiểm tra nhanh

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
