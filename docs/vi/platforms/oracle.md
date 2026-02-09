---
summary: "OpenClaw trên Oracle Cloud (ARM Always Free)"
read_when:
  - Thiết lập OpenClaw trên Oracle Cloud
  - Tìm VPS chi phí thấp để chạy OpenClaw
  - Muốn chạy OpenClaw 24/7 trên một máy chủ nhỏ
title: "Oracle Cloud"
---

# OpenClaw trên Oracle Cloud (OCI)

## Mục tiêu

Chạy một OpenClaw Gateway hoạt động liên tục trên gói **Always Free** ARM của Oracle Cloud.

Gói miễn phí của Oracle có thể rất phù hợp cho OpenClaw (đặc biệt nếu bạn đã có tài khoản OCI), nhưng cũng có một số đánh đổi:

- Kiến trúc ARM (đa số hoạt động tốt, nhưng một số binary có thể chỉ hỗ trợ x86)
- Dung lượng và quá trình đăng ký đôi khi không ổn định

## So sánh chi phí (2026)

| Nhà cung cấp | Gói             | Cấu hình                | Giá/tháng            | Ghi chú                  |
| ------------ | --------------- | ----------------------- | -------------------- | ------------------------ |
| Oracle Cloud | Always Free ARM | tối đa 4 OCPU, 24GB RAM | $0                   | ARM, dung lượng hạn chế  |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM         | ~ $4 | Lựa chọn trả phí rẻ nhất |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM         | $6                   | UI dễ dùng, tài liệu tốt |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM         | $6                   | Nhiều khu vực            |
| Linode       | Nanode          | 1 vCPU, 1GB RAM         | $5                   | Hiện thuộc Akamai        |

---

## Điều kiện tiên quyết

- Tài khoản Oracle Cloud ([đăng ký](https://www.oracle.com/cloud/free/)) — xem [hướng dẫn đăng ký cộng đồng](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) nếu gặp sự cố
- Tài khoản Tailscale (miễn phí tại [tailscale.com](https://tailscale.com))
- Khoảng ~30 phút

## 1. Tạo một OCI Instance

1. Đăng nhập vào [Oracle Cloud Console](https://cloud.oracle.com/)
2. Điều hướng đến **Compute → Instances → Create Instance**
3. Cấu hình:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (hoặc tối đa 4)
   - **Memory:** 12 GB (hoặc tối đa 24 GB)
   - **Boot volume:** 50 GB (tối đa 200 GB miễn phí)
   - **SSH key:** Thêm public key của bạn
4. Nhấn **Create**
5. Ghi lại địa chỉ IP công khai

**Tip:** If instance creation fails with "Out of capacity", try a different availability domain or retry later. Free tier capacity is limited.

## 2. Kết nối và cập nhật

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Lưu ý:** `build-essential` là cần thiết để biên dịch ARM cho một số dependency.

## 3. Cấu hình người dùng và hostname

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Cài đặt Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Việc này kích hoạt Tailscale SSH, cho phép bạn kết nối qua `ssh openclaw` từ bất kỳ thiết bị nào trong tailnet — không cần IP công khai.

Xác minh:

```bash
tailscale status
```

**Từ bây giờ, hãy kết nối qua Tailscale:** `ssh ubuntu@openclaw` (hoặc dùng IP Tailscale).

## 5. Cài đặt OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

Khi được hỏi "How do you want to hatch your bot?", hãy chọn **"Do this later"**.

> Lưu ý: Nếu gặp vấn đề build native trên ARM, hãy bắt đầu với các gói hệ thống (ví dụ: `sudo apt install -y build-essential`) trước khi dùng đến Homebrew.

## 6. Cấu hình Gateway (loopback + xác thực bằng token) và bật Tailscale Serve

Use token auth as the default. It’s predictable and avoids needing any “insecure auth” Control UI flags.

```bash
# Keep the Gateway private on the VM
openclaw config set gateway.bind loopback

# Require auth for the Gateway + Control UI
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Expose over Tailscale Serve (HTTPS + tailnet access)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7. Xác minh

```bash
# Check version
openclaw --version

# Check daemon status
systemctl --user status openclaw-gateway

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8. Siết chặt bảo mật VCN

Now that everything is working, lock down the VCN to block all traffic except Tailscale. OCI's Virtual Cloud Network acts as a firewall at the network edge — traffic is blocked before it reaches your instance.

1. Vào **Networking → Virtual Cloud Networks** trong OCI Console
2. Chọn VCN của bạn → **Security Lists** → Default Security List
3. **Xóa** tất cả rule ingress ngoại trừ:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Giữ nguyên rule egress mặc định (cho phép outbound)

This blocks SSH on port 22, HTTP, HTTPS, and everything else at the network edge. From now on, you can only connect via Tailscale.

---

## Truy cập Control UI

Từ bất kỳ thiết bị nào trong mạng Tailscale của bạn:

```
https://openclaw.<tailnet-name>.ts.net/
```

Thay `<tailnet-name>` bằng tên tailnet của bạn (hiển thị trong `tailscale status`).

No SSH tunnel needed. Tailscale provides:

- Mã hóa HTTPS (chứng chỉ tự động)
- Xác thực qua danh tính Tailscale
- Truy cập từ mọi thiết bị trong tailnet (laptop, điện thoại, v.v.)

---

## Bảo mật: VCN + Tailscale (baseline khuyến nghị)

Khi VCN đã bị khóa (chỉ mở UDP 41641) và Gateway được bind vào loopback, bạn có được phòng thủ nhiều lớp: lưu lượng công khai bị chặn ở rìa mạng, và quyền quản trị diễn ra qua tailnet.

Thiết lập này thường loại bỏ _nhu cầu_ thêm firewall trên host chỉ để ngăn SSH brute force từ Internet — nhưng bạn vẫn nên cập nhật OS, chạy `openclaw security audit`, và kiểm tra để chắc chắn không vô tình lắng nghe trên các interface công khai.

### Những gì đã được bảo vệ sẵn

| Bước truyền thống | Cần không?   | Lý do                                                                    |
| ----------------- | ------------ | ------------------------------------------------------------------------ |
| Firewall UFW      | Không        | VCN chặn lưu lượng trước khi tới instance                                |
| fail2ban          | Không        | Không có brute force khi cổng 22 bị chặn ở VCN                           |
| Hardening sshd    | Không        | Tailscale SSH không dùng sshd                                            |
| Vô hiệu hóa root  | Không        | Tailscale dùng danh tính Tailscale, không phải user hệ thống             |
| Chỉ SSH key       | Không        | Tailscale xác thực qua tailnet của bạn                                   |
| Hardening IPv6    | Thường không | Phụ thuộc cấu hình VCN/subnet; hãy xác minh những gì thực sự được gán/mở |

### Vẫn nên làm

- **Quyền truy cập credential:** `chmod 700 ~/.openclaw`
- **Kiểm toán bảo mật:** `openclaw security audit`
- **Cập nhật hệ thống:** chạy `sudo apt update && sudo apt upgrade` định kỳ
- **Giám sát Tailscale:** xem lại thiết bị trong [Tailscale admin console](https://login.tailscale.com/admin)

### Xác minh trạng thái bảo mật

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Phương án dự phòng: SSH Tunnel

Nếu Tailscale Serve không hoạt động, hãy dùng SSH tunnel:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Sau đó mở `http://localhost:18789`.

---

## Xử lý sự cố

### Tạo instance thất bại ("Out of capacity")

Free tier ARM instances are popular. Try:

- Availability domain khác
- Thử lại vào giờ thấp điểm (sáng sớm)
- Dùng bộ lọc "Always Free" khi chọn shape

### Tailscale không kết nối được

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway không khởi động

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Không truy cập được Control UI

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### Vấn đề binary ARM

Some tools may not have ARM builds. Check:

```bash
uname -m  # Should show aarch64
```

Most npm packages work fine. For binaries, look for `linux-arm64` or `aarch64` releases.

---

## Tính bền vững

Toàn bộ trạng thái nằm trong:

- `~/.openclaw/` — cấu hình, credential, dữ liệu phiên
- `~/.openclaw/workspace/` — workspace (SOUL.md, bộ nhớ, artifacts)

Sao lưu định kỳ:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Xem thêm

- [Gateway remote access](/gateway/remote) — các mô hình truy cập từ xa khác
- [Tailscale integration](/gateway/tailscale) — tài liệu Tailscale đầy đủ
- [Gateway configuration](/gateway/configuration) — tất cả tùy chọn cấu hình
- [DigitalOcean guide](/platforms/digitalocean) — nếu bạn muốn trả phí + đăng ký dễ hơn
- [Hetzner guide](/install/hetzner) — phương án Docker-based
