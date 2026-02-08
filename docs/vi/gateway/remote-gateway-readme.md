---
summary: "Thiết lập đường hầm SSH cho OpenClaw.app kết nối tới một gateway từ xa"
read_when: "Kết nối ứng dụng macOS tới một gateway từ xa qua SSH"
title: "Thiết lập Gateway từ xa"
x-i18n:
  source_path: gateway/remote-gateway-readme.md
  source_hash: b1ae266a7cb4911b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:01Z
---

# Chạy OpenClaw.app với Gateway từ xa

OpenClaw.app sử dụng đường hầm SSH để kết nối tới một gateway từ xa. Hướng dẫn này sẽ chỉ cho bạn cách thiết lập.

## Tổng quan

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Machine                          │
│                                                              │
│  OpenClaw.app ──► ws://127.0.0.1:18789 (local port)           │
│                     │                                        │
│                     ▼                                        │
│  SSH Tunnel ────────────────────────────────────────────────│
│                     │                                        │
└─────────────────────┼──────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                         Remote Machine                        │
│                                                              │
│  Gateway WebSocket ──► ws://127.0.0.1:18789 ──►              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Thiết lập nhanh

### Bước 1: Thêm cấu hình SSH

Chỉnh sửa `~/.ssh/config` và thêm:

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

Thay `<REMOTE_IP>` và `<REMOTE_USER>` bằng giá trị của bạn.

### Bước 2: Sao chép khóa SSH

Sao chép khóa công khai của bạn lên máy từ xa (chỉ cần nhập mật khẩu một lần):

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### Bước 3: Đặt Gateway Token

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### Bước 4: Khởi động đường hầm SSH

```bash
ssh -N remote-gateway &
```

### Bước 5: Khởi động lại OpenClaw.app

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

Ứng dụng bây giờ sẽ kết nối tới gateway từ xa thông qua đường hầm SSH.

---

## Tự động khởi động đường hầm khi đăng nhập

Để đường hầm SSH tự động khởi động khi bạn đăng nhập, hãy tạo một Launch Agent.

### Tạo file PLIST

Lưu file này thành `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>bot.molt.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-gateway</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### Nạp Launch Agent

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

Đường hầm bây giờ sẽ:

- Tự động khởi động khi bạn đăng nhập
- Tự khởi động lại nếu bị lỗi
- Luôn chạy trong nền

Ghi chú cũ: nếu có, hãy xóa mọi LaunchAgent `com.openclaw.ssh-tunnel` còn sót lại.

---

## Xử lý sự cố

**Kiểm tra xem đường hầm có đang chạy không:**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**Khởi động lại đường hầm:**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**Dừng đường hầm:**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## Cách hoạt động

| Thành phần                           | Chức năng                                                   |
| ------------------------------------ | ----------------------------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | Chuyển tiếp cổng cục bộ 18789 tới cổng 18789 trên máy từ xa |
| `ssh -N`                             | SSH không thực thi lệnh từ xa (chỉ chuyển tiếp cổng)        |
| `KeepAlive`                          | Tự động khởi động lại đường hầm nếu bị lỗi                  |
| `RunAtLoad`                          | Khởi động đường hầm khi agent được nạp                      |

OpenClaw.app kết nối tới `ws://127.0.0.1:18789` trên máy khách của bạn. Đường hầm SSH sẽ chuyển tiếp kết nối đó tới cổng 18789 trên máy từ xa, nơi Gateway đang chạy.
