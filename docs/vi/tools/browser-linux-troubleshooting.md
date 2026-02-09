---
summary: "Khắc phục sự cố khởi động CDP của Chrome/Brave/Edge/Chromium cho điều khiển trình duyệt OpenClaw trên Linux"
read_when: "Điều khiển trình duyệt không hoạt động trên Linux, đặc biệt với Chromium dạng snap"
title: "Xử lý sự cố trình duyệt"
---

# Xử lý sự cố trình duyệt (Linux)

## Vấn đề: "Failed to start Chrome CDP on port 18800"

Máy chủ điều khiển trình duyệt của OpenClaw không thể khởi chạy Chrome/Brave/Edge/Chromium với lỗi:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Nguyên nhân gốc rễ

34. Trên Ubuntu (và nhiều distro Linux), cài đặt Chromium mặc định là **gói snap**. Snap's AppArmor confinement interferes with how OpenClaw spawns and monitors the browser process.

Lệnh `apt install chromium` cài đặt một gói stub chuyển hướng sang snap:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

Đây KHÔNG phải là một trình duyệt thực — chỉ là một wrapper.

### Giải pháp 1: Cài đặt Google Chrome (Khuyến nghị)

Cài đặt gói Google Chrome chính thức `.deb`, không bị sandbox bởi snap:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Sau đó cập nhật cấu hình OpenClaw của bạn (`~/.openclaw/openclaw.json`):

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### Giải pháp 2: Dùng Chromium snap với chế độ Chỉ-gắn (Attach-Only)

Nếu buộc phải dùng Chromium dạng snap, hãy cấu hình OpenClaw để gắn vào một trình duyệt được khởi chạy thủ công:

1. Cập nhật cấu hình:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. Khởi động Chromium thủ công:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. (Tùy chọn) Tạo dịch vụ systemd cho người dùng để tự động khởi động Chrome:

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Kích hoạt bằng: `systemctl --user enable --now openclaw-browser.service`

### Xác minh trình duyệt hoạt động

Kiểm tra trạng thái:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Thử duyệt web:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Tham chiếu cấu hình

| Tùy chọn                 | Mô tả                                                                                              | Mặc định                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `browser.enabled`        | Bật điều khiển trình duyệt                                                                         | `true`                                                                                |
| `browser.executablePath` | Đường dẫn tới binary trình duyệt dựa trên Chromium (Chrome/Brave/Edge/Chromium) | auto-detected (ưu tiên trình duyệt mặc định nếu dựa trên Chromium) |
| `browser.headless`       | Chạy không có GUI                                                                                  | `false`                                                                               |
| `browser.noSandbox`      | Thêm cờ `--no-sandbox` (cần cho một số thiết lập Linux)                         | `false`                                                                               |
| `browser.attachOnly`     | Không khởi chạy trình duyệt, chỉ gắn vào phiên hiện có                                             | `false`                                                                               |
| `browser.cdpPort`        | Cổng Chrome DevTools Protocol                                                                      | `18800`                                                                               |

### Vấn đề: "Chrome extension relay is running, but no tab is connected"

You’re using the `chrome` profile (extension relay). It expects the OpenClaw
browser extension to be attached to a live tab.

Các cách khắc phục:

1. **Dùng trình duyệt được quản lý:** `openclaw browser start --browser-profile openclaw`
   (hoặc đặt `browser.defaultProfile: "openclaw"`).
2. **Dùng extension relay:** cài tiện ích mở rộng, mở một tab và nhấp vào biểu tượng tiện ích OpenClaw để gắn.

Ghi chú:

- Profile `chrome` sử dụng **trình duyệt Chromium mặc định của hệ thống** khi có thể.
- Các profile `openclaw` cục bộ tự động gán `cdpPort`/`cdpUrl`; chỉ đặt các giá trị đó cho CDP từ xa.
