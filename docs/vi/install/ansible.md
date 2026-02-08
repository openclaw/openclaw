---
summary: "Cài đặt OpenClaw tự động, tăng cường bảo mật với Ansible, VPN Tailscale và cô lập bằng firewall"
read_when:
  - Bạn muốn triển khai máy chủ tự động với tăng cường bảo mật
  - Bạn cần thiết lập cô lập bằng firewall với truy cập qua VPN
  - Bạn đang triển khai lên máy chủ Debian/Ubuntu từ xa
title: "Ansible"
x-i18n:
  source_path: install/ansible.md
  source_hash: b1e1e1ea13bff37b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:20Z
---

# Cài đặt Ansible

Cách được khuyến nghị để triển khai OpenClaw lên máy chủ production là thông qua **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — một trình cài đặt tự động với kiến trúc ưu tiên bảo mật.

## Khởi động nhanh

Cài đặt chỉ với một lệnh:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 Hướng dẫn đầy đủ: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> Repo openclaw-ansible là nguồn thông tin chính thức cho việc triển khai bằng Ansible. Trang này chỉ là phần tổng quan nhanh.

## Những gì bạn nhận được

- 🔒 **Bảo mật ưu tiên firewall**: UFW + cô lập Docker (chỉ cho phép SSH + Tailscale)
- 🔐 **VPN Tailscale**: Truy cập từ xa an toàn mà không cần phơi bày dịch vụ ra Internet
- 🐳 **Docker**: Các container sandbox cô lập, chỉ bind localhost
- 🛡️ **Phòng thủ nhiều lớp**: Kiến trúc bảo mật 4 lớp
- 🚀 **Thiết lập một lệnh**: Triển khai hoàn chỉnh trong vài phút
- 🔧 **Tích hợp systemd**: Tự khởi động khi boot kèm tăng cường bảo mật

## Yêu cầu

- **OS**: Debian 11+ hoặc Ubuntu 20.04+
- **Quyền truy cập**: Quyền root hoặc sudo
- **Mạng**: Kết nối Internet để cài đặt gói
- **Ansible**: 2.14+ (được cài tự động bởi script khởi động nhanh)

## Những gì được cài đặt

Playbook Ansible sẽ cài đặt và cấu hình:

1. **Tailscale** (VPN mesh cho truy cập từ xa an toàn)
2. **Firewall UFW** (chỉ mở cổng SSH + Tailscale)
3. **Docker CE + Compose V2** (cho sandbox của tác tử)
4. **Node.js 22.x + pnpm** (phụ thuộc runtime)
5. **OpenClaw** (chạy trên host, không container hóa)
6. **Dịch vụ systemd** (tự khởi động kèm tăng cường bảo mật)

Lưu ý: Gateway chạy **trực tiếp trên host** (không chạy trong Docker), nhưng các sandbox của tác tử sử dụng Docker để cô lập. Xem [Sandboxing](/gateway/sandboxing) để biết chi tiết.

## Thiết lập sau cài đặt

Sau khi cài đặt hoàn tất, chuyển sang người dùng openclaw:

```bash
sudo -i -u openclaw
```

Script sau cài đặt sẽ hướng dẫn bạn:

1. **Trình hướng dẫn ban đầu**: Cấu hình các thiết lập OpenClaw
2. **Đăng nhập nhà cung cấp**: Kết nối WhatsApp/Telegram/Discord/Signal
3. **Kiểm tra Gateway**: Xác minh cài đặt
4. **Thiết lập Tailscale**: Kết nối vào mesh VPN của bạn

### Lệnh nhanh

```bash
# Check service status
sudo systemctl status openclaw

# View live logs
sudo journalctl -u openclaw -f

# Restart gateway
sudo systemctl restart openclaw

# Provider login (run as openclaw user)
sudo -i -u openclaw
openclaw channels login
```

## Kiến trúc bảo mật

### Phòng thủ 4 lớp

1. **Firewall (UFW)**: Chỉ công khai SSH (22) + Tailscale (41641/udp)
2. **VPN (Tailscale)**: Gateway chỉ truy cập được qua mesh VPN
3. **Cô lập Docker**: Chuỗi iptables DOCKER-USER ngăn phơi bày cổng ra ngoài
4. **Tăng cường systemd**: NoNewPrivileges, PrivateTmp, người dùng không đặc quyền

### Xác minh

Kiểm tra bề mặt tấn công từ bên ngoài:

```bash
nmap -p- YOUR_SERVER_IP
```

Kết quả chỉ nên hiển thị **duy nhất cổng 22** (SSH) đang mở. Tất cả dịch vụ khác (gateway, Docker) đều được khóa.

### Khả dụng của Docker

Docker được cài đặt cho **sandbox của tác tử** (thực thi công cụ cô lập), không phải để chạy gateway. Gateway chỉ bind vào localhost và được truy cập qua VPN Tailscale.

Xem [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) để cấu hình sandbox.

## Cài đặt thủ công

Nếu bạn muốn kiểm soát thủ công thay vì tự động hóa:

```bash
# 1. Install prerequisites
sudo apt update && sudo apt install -y ansible git

# 2. Clone repository
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Install Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. Run playbook
./run-playbook.sh

# Or run directly (then manually execute /tmp/openclaw-setup.sh after)
# ansible-playbook playbook.yml --ask-become-pass
```

## Cập nhật OpenClaw

Trình cài đặt Ansible thiết lập OpenClaw để cập nhật thủ công. Xem [Updating](/install/updating) để biết quy trình cập nhật tiêu chuẩn.

Để chạy lại playbook Ansible (ví dụ: khi thay đổi cấu hình):

```bash
cd openclaw-ansible
./run-playbook.sh
```

Lưu ý: Playbook có tính idempotent và an toàn khi chạy nhiều lần.

## Xử lý sự cố

### Firewall chặn kết nối của tôi

Nếu bạn bị khóa truy cập:

- Đảm bảo bạn có thể truy cập qua VPN Tailscale trước
- Truy cập SSH (cổng 22) luôn được cho phép
- Gateway **chỉ** có thể truy cập qua Tailscale theo thiết kế

### Dịch vụ không khởi động

```bash
# Check logs
sudo journalctl -u openclaw -n 100

# Verify permissions
sudo ls -la /opt/openclaw

# Test manual start
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Sự cố sandbox Docker

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### Đăng nhập nhà cung cấp thất bại

Đảm bảo bạn đang chạy với người dùng `openclaw`:

```bash
sudo -i -u openclaw
openclaw channels login
```

## Cấu hình nâng cao

Để xem chi tiết kiến trúc bảo mật và xử lý sự cố:

- [Kiến trúc bảo mật](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Chi tiết kỹ thuật](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Hướng dẫn xử lý sự cố](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## Liên quan

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — hướng dẫn triển khai đầy đủ
- [Docker](/install/docker) — thiết lập gateway dạng container
- [Sandboxing](/gateway/sandboxing) — cấu hình sandbox của tác tử
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — cô lập theo từng tác tử
