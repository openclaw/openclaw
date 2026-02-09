---
summary: "OpenClaw trên DigitalOcean (tùy chọn VPS trả phí đơn giản)"
read_when:
  - Thiết lập OpenClaw trên DigitalOcean
  - Tìm dịch vụ VPS giá rẻ cho OpenClaw
title: "DigitalOcean"
---

# OpenClaw trên DigitalOcean

## Mục tiêu

Chạy một Gateway OpenClaw hoạt động liên tục trên DigitalOcean với **$6/tháng** (hoặc $4/tháng với giá đặt trước).

Nếu bạn muốn tùy chọn $0/tháng và không ngại ARM + thiết lập phụ thuộc nhà cung cấp, xem [hướng dẫn Oracle Cloud](/platforms/oracle).

## So sánh chi phí (2026)

| Nhà cung cấp | Gói             | Cấu hình                | Giá/tháng                                                      | Ghi chú                                   |
| ------------ | --------------- | ----------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| Oracle Cloud | Always Free ARM | tối đa 4 OCPU, 24GB RAM | $0                                                             | ARM, dung lượng hạn chế / đăng ký rắc rối |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM         | €3.79 (~$4) | Tùy chọn trả phí rẻ nhất                  |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM         | $6                                                             | UI dễ dùng, tài liệu tốt                  |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM         | $6                                                             | Nhiều vị trí                              |
| Linode       | Nanode          | 1 vCPU, 1GB RAM         | $5                                                             | Hiện thuộc Akamai                         |

**Chọn nhà cung cấp:**

- DigitalOcean: UX đơn giản nhất + thiết lập ổn định (hướng dẫn này)
- Hetzner: giá/hiệu năng tốt (xem [hướng dẫn Hetzner](/install/hetzner))
- Oracle Cloud: có thể $0/tháng, nhưng cầu kỳ hơn và chỉ ARM (xem [hướng dẫn Oracle](/platforms/oracle))

---

## Điều kiện tiên quyết

- Tài khoản DigitalOcean ([đăng ký với $200 tín dụng miễn phí](https://m.do.co/c/signup))
- Cặp khóa SSH (hoặc sẵn sàng dùng xác thực mật khẩu)
- ~20 phút

## 1. Tạo Droplet

1. Đăng nhập [DigitalOcean](https://cloud.digitalocean.com/)
2. Nhấp **Create → Droplets**
3. Chọn:
   - **Region:** Gần bạn nhất (hoặc người dùng của bạn)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/tháng** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH key (khuyến nghị) hoặc mật khẩu
4. Nhấp **Create Droplet**
5. Ghi lại địa chỉ IP

## 2) Kết nối qua SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. Cài đặt OpenClaw

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. Chạy Hướng dẫn ban đầu

```bash
openclaw onboard --install-daemon
```

Trình hướng dẫn sẽ dẫn bạn qua:

- Xác thực mô hình (khóa API hoặc OAuth)
- Thiết lập kênh (Telegram, WhatsApp, Discord, v.v.)
- Token Gateway (tự động tạo)
- Cài đặt daemon (systemd)

## 5. Xác minh Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. Truy cập Bảng điều khiển

39. Gateway mặc định bind vào loopback. 40. Để truy cập Control UI:

**Tùy chọn A: Đường hầm SSH (khuyến nghị)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Tùy chọn B: Tailscale Serve (HTTPS, chỉ loopback)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Mở: `https://<magicdns>/`

Ghi chú:

- Serve giữ Gateway ở chế độ chỉ loopback và xác thực qua header danh tính Tailscale.
- Để yêu cầu token/mật khẩu thay thế, đặt `gateway.auth.allowTailscale: false` hoặc dùng `gateway.auth.mode: "password"`.

**Tùy chọn C: Bind tailnet (không Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Mở: `http://<tailscale-ip>:18789` (yêu cầu token).

## 7. Kết nối các kênh của bạn

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

Xem [Channels](/channels) cho các nhà cung cấp khác.

---

## Tối ưu cho RAM 1GB

41. Droplet $6 chỉ có 1GB RAM. 42. Để giữ mọi thứ chạy mượt mà:

### Thêm swap (khuyến nghị)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Dùng mô hình nhẹ hơn

Nếu gặp OOM, cân nhắc:

- Dùng mô hình qua API (Claude, GPT) thay vì mô hình cục bộ
- Đặt `agents.defaults.model.primary` sang mô hình nhỏ hơn

### Theo dõi bộ nhớ

```bash
free -h
htop
```

---

## Tính bền vững

Toàn bộ trạng thái nằm tại:

- `~/.openclaw/` — cấu hình, thông tin xác thực, dữ liệu phiên
- `~/.openclaw/workspace/` — workspace (SOUL.md, bộ nhớ, v.v.)

43. Những thứ này tồn tại qua các lần reboot. 44. Hãy sao lưu chúng định kỳ:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Lựa chọn miễn phí Oracle Cloud

Oracle Cloud cung cấp các instance ARM **Always Free** mạnh hơn đáng kể so với mọi tùy chọn trả phí ở đây — với $0/tháng.

| Những gì bạn nhận      | Cấu hình              |
| ---------------------- | --------------------- |
| **4 OCPUs**            | ARM Ampere A1         |
| **24GB RAM**           | Dư sức dùng           |
| **200GB storage**      | Block volume          |
| **Miễn phí vĩnh viễn** | Không bị tính phí thẻ |

**Lưu ý:**

- Đăng ký có thể hơi khó (thử lại nếu thất bại)
- Kiến trúc ARM — hầu hết đều chạy tốt, nhưng một số binary cần bản build ARM

45. Để xem hướng dẫn thiết lập đầy đủ, xem [Oracle Cloud](/platforms/oracle). 46. Để biết mẹo đăng ký và khắc phục sự cố quá trình enrollment, xem [hướng dẫn cộng đồng này](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Xử lý sự cố

### Gateway không khởi động

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Cổng đã được sử dụng

```bash
lsof -i :18789
kill <PID>
```

### Hết bộ nhớ

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## Xem thêm

- [Hướng dẫn Hetzner](/install/hetzner) — rẻ hơn, mạnh hơn
- [Cài đặt Docker](/install/docker) — thiết lập dạng container
- [Tailscale](/gateway/tailscale) — truy cập từ xa an toàn
- [Cấu hình](/gateway/configuration) — tham chiếu cấu hình đầy đủ
