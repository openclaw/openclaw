---
summary: "Luồng ứng dụng macOS để điều khiển một gateway OpenClaw từ xa qua SSH"
read_when:
  - Khi thiết lập hoặc gỡ lỗi điều khiển mac từ xa
title: "Điều khiển từ xa"
x-i18n:
  source_path: platforms/mac/remote.md
  source_hash: 61b43707250d5515
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:49Z
---

# OpenClaw từ xa (macOS ⇄ máy chủ từ xa)

Luồng này cho phép ứng dụng macOS hoạt động như một bộ điều khiển từ xa đầy đủ cho một gateway OpenClaw chạy trên máy chủ khác (desktop/server). Đây là tính năng **Remote over SSH** (chạy từ xa) của ứng dụng. Tất cả tính năng—kiểm tra trạng thái, chuyển tiếp Voice Wake và Web Chat—đều dùng chung cấu hình SSH từ xa trong _Settings → General_.

## Chế độ

- **Local (this Mac)**: Mọi thứ chạy trên laptop. Không dùng SSH.
- **Remote over SSH (default)**: Các lệnh OpenClaw được thực thi trên máy chủ từ xa. Ứng dụng mac mở một kết nối SSH với `-o BatchMode` cùng identity/key bạn chọn và một port-forward cục bộ.
- **Remote direct (ws/wss)**: Không có đường hầm SSH. Ứng dụng mac kết nối trực tiếp tới URL của gateway (ví dụ qua Tailscale Serve hoặc một reverse proxy HTTPS công khai).

## Truyền tải từ xa

Chế độ remote hỗ trợ hai kiểu truyền tải:

- **SSH tunnel** (mặc định): Dùng `ssh -N -L ...` để chuyển tiếp cổng gateway về localhost. Gateway sẽ thấy IP của node là `127.0.0.1` vì đường hầm là loopback.
- **Direct (ws/wss)**: Kết nối thẳng tới URL của gateway. Gateway sẽ thấy IP thật của client.

## Điều kiện tiên quyết trên máy chủ từ xa

1. Cài Node + pnpm và build/cài OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`).
2. Đảm bảo `openclaw` nằm trong PATH cho shell không tương tác (tạo symlink vào `/usr/local/bin` hoặc `/opt/homebrew/bin` nếu cần).
3. Mở SSH với xác thực bằng khóa. Khuyến nghị dùng IP **Tailscale** để có khả năng kết nối ổn định ngoài LAN.

## Thiết lập ứng dụng macOS

1. Mở _Settings → General_.
2. Trong **OpenClaw runs**, chọn **Remote over SSH** và cấu hình:
   - **Transport**: **SSH tunnel** hoặc **Direct (ws/wss)**.
   - **SSH target**: `user@host` (tùy chọn `:port`).
     - Nếu gateway ở cùng LAN và quảng bá Bonjour, chọn từ danh sách phát hiện để tự động điền trường này.
   - **Gateway URL** (chỉ Direct): `wss://gateway.example.ts.net` (hoặc `ws://...` cho local/LAN).
   - **Identity file** (nâng cao): đường dẫn tới khóa của bạn.
   - **Project root** (nâng cao): đường dẫn checkout trên máy từ xa dùng cho các lệnh.
   - **CLI path** (nâng cao): đường dẫn tùy chọn tới entrypoint/binary `openclaw` có thể chạy (tự động điền khi được quảng bá).
3. Nhấn **Test remote**. Thành công cho biết `openclaw status --json` từ xa chạy đúng. Thất bại thường do PATH/CLI; exit 127 nghĩa là CLI không được tìm thấy trên máy từ xa.
4. Kiểm tra trạng thái và Web Chat giờ sẽ tự động chạy qua đường hầm SSH này.

## Web Chat

- **SSH tunnel**: Web Chat kết nối tới gateway qua cổng WebSocket điều khiển đã được chuyển tiếp (mặc định 18789).
- **Direct (ws/wss)**: Web Chat kết nối thẳng tới URL gateway đã cấu hình.
- Không còn máy chủ HTTP WebChat riêng biệt nữa.

## Quyền

- Máy chủ từ xa cần các phê duyệt TCC giống như local (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications). Chạy onboarding trên máy đó để cấp một lần.
- Các node quảng bá trạng thái quyền của chúng qua `node.list` / `node.describe` để các agent biết những gì khả dụng.

## Ghi chú bảo mật

- Ưu tiên bind loopback trên máy chủ từ xa và kết nối qua SSH hoặc Tailscale.
- Nếu bạn bind Gateway vào một interface không phải loopback, hãy yêu cầu xác thực bằng token/mật khẩu.
- Xem [Security](/gateway/security) và [Tailscale](/gateway/tailscale).

## Luồng đăng nhập WhatsApp (từ xa)

- Chạy `openclaw channels login --verbose` **trên máy chủ từ xa**. Quét QR bằng WhatsApp trên điện thoại của bạn.
- Chạy lại đăng nhập trên máy đó nếu xác thực hết hạn. Kiểm tra trạng thái sẽ hiển thị vấn đề liên kết.

## Xử lý sự cố

- **exit 127 / not found**: `openclaw` không nằm trong PATH cho shell không đăng nhập. Thêm vào `/etc/paths`, shell rc của bạn, hoặc symlink vào `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: kiểm tra khả năng kết nối SSH, PATH, và đảm bảo Baileys đã đăng nhập (`openclaw status --json`).
- **Web Chat bị treo**: xác nhận gateway đang chạy trên máy từ xa và cổng được chuyển tiếp khớp với cổng WS của gateway; UI yêu cầu kết nối WS ở trạng thái tốt.
- **Node IP hiển thị 127.0.0.1**: điều này là ожидаемо với SSH tunnel. Chuyển **Transport** sang **Direct (ws/wss)** nếu bạn muốn gateway thấy IP thật của client.
- **Voice Wake**: các cụm kích hoạt được chuyển tiếp tự động trong chế độ remote; không cần forwarder riêng.

## Âm thanh thông báo

Chọn âm thanh theo từng thông báo từ script với `openclaw` và `node.invoke`, ví dụ:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Ứng dụng không còn công tắc “âm thanh mặc định” toàn cục; bên gọi sẽ chọn âm thanh (hoặc không) cho từng yêu cầu.
