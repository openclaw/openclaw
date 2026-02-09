---
summary: "Thiết lập nâng cao và quy trình làm việc cho phát triển OpenClaw"
read_when:
  - Thiết lập một máy mới
  - Bạn muốn “mới nhất + tốt nhất” mà không làm hỏng thiết lập cá nhân
title: "Thiết lập"
---

# Thiết lập

<Note>
If you are setting up for the first time, start with [Getting Started](/start/getting-started).
For wizard details, see [Onboarding Wizard](/start/wizard).
</Note>

Cập nhật lần cuối: 2026-01-01

## TL;DR

- **Tùy biến nằm ngoài repo:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (config).
- **Quy trình ổn định:** cài app macOS; để app chạy Gateway đi kèm.
- **Quy trình bleeding edge:** tự chạy Gateway qua `pnpm gateway:watch`, rồi để app macOS kết nối ở chế độ Local.

## Điều kiện tiên quyết (từ source)

- Node `>=22`
- `pnpm`
- Docker (tùy chọn; chỉ cho thiết lập container/e2e — xem [Docker](/install/docker))

## Chiến lược tùy biến (để cập nhật không gây rắc rối)

Nếu bạn muốn “100% tùy biến theo mình” _và_ cập nhật dễ dàng, hãy giữ phần tùy chỉnh trong:

- **Config:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memories; nên là repo git riêng tư)

Khởi tạo một lần:

```bash
openclaw setup
```

Từ bên trong repo này, dùng entry CLI cục bộ:

```bash
openclaw setup
```

Nếu bạn chưa cài bản global, hãy chạy qua `pnpm openclaw setup`.

## Chạy Gateway từ repo này

Sau `pnpm build`, bạn có thể chạy CLI đóng gói trực tiếp:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Quy trình ổn định (ưu tiên app macOS)

1. Cài đặt + khởi chạy **OpenClaw.app** (menu bar).
2. Hoàn tất checklist onboarding/quyền (các prompt TCC).
3. Đảm bảo Gateway ở **Local** và đang chạy (app quản lý).
4. Liên kết các surface (ví dụ: WhatsApp):

```bash
openclaw channels login
```

5. Kiểm tra nhanh:

```bash
openclaw health
```

Nếu onboarding không có trong bản build của bạn:

- Chạy `openclaw setup`, rồi `openclaw channels login`, sau đó khởi động Gateway thủ công (`openclaw gateway`).

## Quy trình bleeding edge (Gateway trong terminal)

Mục tiêu: làm việc trên Gateway TypeScript, có hot reload, và vẫn giữ UI app macOS được kết nối.

### 0. (Tùy chọn) Chạy app macOS từ source

Nếu bạn cũng muốn app macOS ở bleeding edge:

```bash
./scripts/restart-mac.sh
```

### 1. Khởi động Gateway dev

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` chạy gateway ở chế độ watch và reload khi TypeScript thay đổi.

### 2. Trỏ app macOS tới Gateway đang chạy

Trong **OpenClaw.app**:

- Connection Mode: **Local**
  App sẽ kết nối tới gateway đang chạy trên cổng đã cấu hình.

### 3. Xác minh

- Trạng thái Gateway trong app sẽ hiển thị **“Using existing gateway …”**
- Hoặc qua CLI:

```bash
openclaw health
```

### Các lỗi thường gặp

- **Sai cổng:** WS của Gateway mặc định là `ws://127.0.0.1:18789`; hãy giữ app + CLI dùng cùng một cổng.
- **Vị trí lưu trạng thái:**
  - Thông tin xác thực: `~/.openclaw/credentials/`
  - Phiên: `~/.openclaw/agents/<agentId>/sessions/`
  - Log: `/tmp/openclaw/`

## Bản đồ lưu trữ thông tin xác thực

Dùng khi debug xác thực hoặc quyết định sao lưu:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: config/env hoặc `channels.telegram.tokenFile`
- **Discord bot token**: config/env (chưa hỗ trợ file token)
- **Slack tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Hồ sơ xác thực mô hình**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Nhập OAuth cũ**: `~/.openclaw/credentials/oauth.json`
  Chi tiết hơn: [Security](/gateway/security#credential-storage-map).

## Cập nhật (không làm hỏng thiết lập của bạn)

- Giữ `~/.openclaw/workspace` và `~/.openclaw/` là “phần của bạn”; đừng đưa prompt/config cá nhân vào repo `openclaw`.
- Cập nhật source: `git pull` + `pnpm install` (khi lockfile thay đổi) + tiếp tục dùng `pnpm gateway:watch`.

## Linux (systemd user service)

Onboarding sẽ cố gắng bật lingering cho bạn (có thể yêu cầu sudo). By default, systemd stops user
services on logout/idle, which kills the Gateway. Đối với các máy chủ luôn bật hoặc đa người dùng, hãy cân nhắc dùng dịch vụ **system** thay vì dịch vụ user (không cần lingering). If it’s still off, run:

```bash
sudo loginctl enable-linger $USER
```

Xem [Gateway runbook](/gateway) để biết các ghi chú về systemd. Các dự án thực tế từ cộng đồng.

## Tài liệu liên quan

- [Gateway runbook](/gateway) (cờ, giám sát, cổng)
- [Gateway configuration](/gateway/configuration) (schema cấu hình + ví dụ)
- [Discord](/channels/discord) và [Telegram](/channels/telegram) (thẻ trả lời + cài đặt replyToMode)
- [Thiết lập trợ lý OpenClaw](/start/openclaw)
- [App macOS](/platforms/macos) (vòng đời gateway)
