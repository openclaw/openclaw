---
summary: "OpenClaw trên Raspberry Pi (thiết lập tự host tiết kiệm)"
read_when:
  - Thiết lập OpenClaw trên Raspberry Pi
  - Chạy OpenClaw trên thiết bị ARM
  - Xây dựng AI cá nhân luôn bật với chi phí thấp
title: "Raspberry Pi"
---

# OpenClaw trên Raspberry Pi

## Mục tiêu

Chạy một OpenClaw Gateway liên tục, luôn bật trên Raspberry Pi với chi phí một lần **~$35-80** (không phí hàng tháng).

Phù hợp cho:

- Trợ lý AI cá nhân 24/7
- Trung tâm tự động hóa nhà
- Bot Telegram/WhatsApp công suất thấp, luôn sẵn sàng

## Yêu cầu phần cứng

| Mẫu Pi          | RAM     | Hoạt động? | Ghi chú                            |
| --------------- | ------- | ---------- | ---------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ Tốt nhất | Nhanh nhất, khuyến nghị            |
| **Pi 4**        | 4GB     | ✅ Tốt      | Điểm cân bằng cho đa số người dùng |
| **Pi 4**        | 2GB     | ✅ Ổn       | Hoạt động, nên thêm swap           |
| **Pi 4**        | 1GB     | ⚠️ Chật    | Có thể với swap, cấu hình tối giản |
| **Pi 3B+**      | 1GB     | ⚠️ Chậm    | Chạy được nhưng ì ạch              |
| **Pi Zero 2 W** | 512MB   | ❌          | Không khuyến nghị                  |

**Cấu hình tối thiểu:** 1GB RAM, 1 lõi, 500MB dung lượng  
**Khuyến nghị:** 2GB+ RAM, OS 64-bit, thẻ SD 16GB+ (hoặc USB SSD)

## Những thứ bạn cần

- Raspberry Pi 4 hoặc 5 (khuyến nghị 2GB+)
- Thẻ MicroSD (16GB+) hoặc USB SSD (hiệu năng tốt hơn)
- Nguồn điện (khuyến nghị PSU chính hãng của Pi)
- Kết nối mạng (Ethernet hoặc WiFi)
- ~30 phút

## 1. Ghi hệ điều hành

Sử dụng **Raspberry Pi OS Lite (64-bit)** — không cần giao diện desktop cho máy chủ headless.

1. Tải [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Chọn OS: **Raspberry Pi OS Lite (64-bit)**
3. Nhấn biểu tượng bánh răng (⚙️) để cấu hình trước:
   - Đặt hostname: `gateway-host`
   - Bật SSH
   - Đặt username/password
   - Cấu hình WiFi (nếu không dùng Ethernet)
4. Ghi vào thẻ SD / ổ USB
5. Gắn và khởi động Pi

## 2) Kết nối qua SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. Thiết lập hệ thống

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Cài Node.js 22 (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Thêm Swap (Quan trọng cho 2GB trở xuống)

Swap giúp tránh lỗi hết bộ nhớ:

```bash
# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize for low RAM (reduce swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6. Cài đặt OpenClaw

### Tùy chọn A: Cài đặt tiêu chuẩn (Khuyến nghị)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Tùy chọn B: Cài đặt hackable (Dành cho vọc vạch)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

Cài đặt hackable cho bạn quyền truy cập trực tiếp vào log và mã nguồn — hữu ích khi gỡ lỗi các vấn đề đặc thù ARM.

## 7. Chạy Hướng dẫn ban đầu

```bash
openclaw onboard --install-daemon
```

Làm theo trình hướng dẫn:

1. **Chế độ Gateway:** Local
2. **Xác thực:** Khuyến nghị khóa API (OAuth có thể khó ổn định trên Pi headless)
3. **Kênh:** Telegram là dễ bắt đầu nhất
4. **Daemon:** Có (systemd)

## 8) Xác minh cài đặt

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. Truy cập Dashboard

Vì Pi là headless, hãy dùng đường hầm SSH:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

Hoặc dùng Tailscale để truy cập luôn bật:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Tối ưu hiệu năng

### Dùng USB SSD (Cải thiện rất lớn)

SD cards are slow and wear out. A USB SSD dramatically improves performance:

```bash
# Check if booting from USB
lsblk
```

Xem [hướng dẫn boot USB cho Pi](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) để thiết lập.

### Giảm sử dụng bộ nhớ

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### Giám sát tài nguyên

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## Ghi chú riêng cho ARM

### Tương thích nhị phân

Hầu hết tính năng OpenClaw hoạt động trên ARM64, nhưng một số nhị phân bên ngoài có thể cần bản build cho ARM:

| Công cụ                               | Trạng thái ARM64 | Ghi chú                             |
| ------------------------------------- | ---------------- | ----------------------------------- |
| Node.js               | ✅                | Hoạt động rất tốt                   |
| WhatsApp (Baileys) | ✅                | JS thuần, không vấn đề              |
| Telegram                              | ✅                | JS thuần, không vấn đề              |
| gog (Gmail CLI)    | ⚠️               | Kiểm tra bản phát hành cho ARM      |
| Chromium (browser) | ✅                | `sudo apt install chromium-browser` |

If a skill fails, check if its binary has an ARM build. Many Go/Rust tools do; some don't.

### 32-bit vs 64-bit

**Always use 64-bit OS.** Node.js and many modern tools require it. Check with:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Thiết lập mô hình khuyến nghị

Vì Pi chỉ đóng vai trò Gateway (mô hình chạy trên cloud), hãy dùng các mô hình dựa trên API:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-20250514",
        "fallbacks": ["openai/gpt-4o-mini"]
      }
    }
  }
}
```

**Don't try to run local LLMs on a Pi** — even small models are too slow. Let Claude/GPT do the heavy lifting.

---

## Tự khởi động khi boot

Trình hướng dẫn ban đầu đã thiết lập, nhưng để kiểm tra:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Xử lý sự cố

### Hết bộ nhớ (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Hiệu năng chậm

- Dùng USB SSD thay vì thẻ SD
- Tắt các dịch vụ không dùng: `sudo systemctl disable cups bluetooth avahi-daemon`
- Kiểm tra CPU bị throttling: `vcgencmd get_throttled` (nên trả về `0x0`)

### Dịch vụ không khởi động

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### Vấn đề nhị phân ARM

Nếu một skill lỗi với "exec format error":

1. Kiểm tra xem nhị phân có bản build ARM64 không
2. Thử build từ mã nguồn
3. Hoặc dùng container Docker có hỗ trợ ARM

### WiFi bị rớt

Đối với Pi headless dùng WiFi:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## So sánh chi phí

| Thiết lập                         | Chi phí một lần      | Chi phí hàng tháng          | Ghi chú                                             |
| --------------------------------- | -------------------- | --------------------------- | --------------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0                          | + điện (~$5/năm) |
| **Pi 4 (4GB)** | ~$55 | $0                          | Khuyến nghị                                         |
| **Pi 5 (4GB)** | ~$60 | $0                          | Hiệu năng tốt nhất                                  |
| **Pi 5 (8GB)** | ~$80 | $0                          | Dư thừa nhưng bền lâu                               |
| DigitalOcean                      | $0                   | $6/tháng                    | $72/năm                                             |
| Hetzner                           | $0                   | €3.79/tháng | ~$50/năm                            |

**Điểm hòa vốn:** Một Pi tự hoàn vốn sau ~6-12 tháng so với VPS cloud.

---

## Xem thêm

- [Linux guide](/platforms/linux) — thiết lập Linux chung
- [DigitalOcean guide](/platforms/digitalocean) — lựa chọn cloud
- [Hetzner guide](/install/hetzner) — thiết lập Docker
- [Tailscale](/gateway/tailscale) — truy cập từ xa
- [Nodes](/nodes) — ghép laptop/điện thoại của bạn với gateway Pi
