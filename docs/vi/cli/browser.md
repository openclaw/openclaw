---
summary: "Tham chiếu CLI cho `openclaw browser` (hồ sơ, tab, hành động, chuyển tiếp tiện ích mở rộng)"
read_when:
  - Bạn dùng `openclaw browser` và muốn xem ví dụ cho các tác vụ phổ biến
  - Bạn muốn điều khiển một trình duyệt chạy trên máy khác thông qua một node host
  - Bạn muốn dùng chuyển tiếp tiện ích mở rộng Chrome (gắn/tách qua nút trên thanh công cụ)
title: "browser"
x-i18n:
  source_path: cli/browser.md
  source_hash: af35adfd68726fd5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:16Z
---

# `openclaw browser`

Quản lý máy chủ điều khiển trình duyệt của OpenClaw và chạy các hành động trình duyệt (tab, snapshot, screenshot, điều hướng, nhấp chuột, gõ phím).

Liên quan:

- Công cụ + API trình duyệt: [Browser tool](/tools/browser)
- Chuyển tiếp tiện ích mở rộng Chrome: [Chrome extension](/tools/chrome-extension)

## Cờ thường dùng

- `--url <gatewayWsUrl>`: URL WebSocket của Gateway (mặc định lấy từ cấu hình).
- `--token <token>`: token của Gateway (nếu cần).
- `--timeout <ms>`: thời gian chờ yêu cầu (ms).
- `--browser-profile <name>`: chọn một hồ sơ trình duyệt (mặc định từ cấu hình).
- `--json`: đầu ra có thể đọc bằng máy (nơi được hỗ trợ).

## Khởi động nhanh (cục bộ)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Hồ sơ

Hồ sơ là các cấu hình định tuyến trình duyệt được đặt tên. Trên thực tế:

- `openclaw`: khởi chạy/đính kèm một phiên bản Chrome do OpenClaw quản lý riêng (thư mục dữ liệu người dùng tách biệt).
- `chrome`: điều khiển các tab Chrome hiện có của bạn thông qua chuyển tiếp tiện ích mở rộng Chrome.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Dùng một hồ sơ cụ thể:

```bash
openclaw browser --browser-profile work tabs
```

## Tab

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / screenshot / hành động

Snapshot:

```bash
openclaw browser snapshot
```

Screenshot:

```bash
openclaw browser screenshot
```

Điều hướng/nhấp/gõ (tự động hóa UI dựa trên ref):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chuyển tiếp tiện ích mở rộng Chrome (gắn qua nút trên thanh công cụ)

Chế độ này cho phép tác tử điều khiển một tab Chrome hiện có mà bạn gắn thủ công (không tự động gắn).

Cài đặt tiện ích mở rộng dạng unpacked vào một đường dẫn ổn định:

```bash
openclaw browser extension install
openclaw browser extension path
```

Sau đó trong Chrome → `chrome://extensions` → bật “Developer mode” → “Load unpacked” → chọn thư mục đã in ra.

Hướng dẫn đầy đủ: [Chrome extension](/tools/chrome-extension)

## Điều khiển trình duyệt từ xa (proxy node host)

Nếu Gateway chạy trên một máy khác với trình duyệt, hãy chạy một **node host** trên máy có Chrome/Brave/Edge/Chromium. Gateway sẽ proxy các hành động trình duyệt tới node đó (không cần máy chủ điều khiển trình duyệt riêng).

Dùng `gateway.nodes.browser.mode` để kiểm soát định tuyến tự động và `gateway.nodes.browser.node` để ghim một node cụ thể nếu có nhiều node được kết nối.

Bảo mật + thiết lập từ xa: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
