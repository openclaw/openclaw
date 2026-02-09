---
summary: "Hỗ trợ Linux + trạng thái ứng dụng đồng hành"
read_when:
  - Tìm trạng thái ứng dụng đồng hành trên Linux
  - Lập kế hoạch phạm vi nền tảng hoặc đóng góp
title: "Ứng dụng Linux"
---

# Ứng dụng Linux

The Gateway is fully supported on Linux. **Node là runtime được khuyến nghị**.
Bun is not recommended for the Gateway (WhatsApp/Telegram bugs).

Native Linux companion apps are planned. Contributions are welcome if you want to help build one.

## Lộ trình nhanh cho người mới (VPS)

1. Cài đặt Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Từ laptop của bạn: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Mở `http://127.0.0.1:18789/` và dán token của bạn

Hướng dẫn VPS từng bước: [exe.dev](/install/exe-dev)

## Cài đặt

- [Bắt đầu](/start/getting-started)
- [Cài đặt & cập nhật](/install/updating)
- Luồng tùy chọn: [Bun (thử nghiệm)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Runbook Gateway](/gateway)
- [Cấu hình](/gateway/configuration)

## Cài đặt dịch vụ Gateway (CLI)

Dùng một trong các cách sau:

```
openclaw onboard --install-daemon
```

Hoặc:

```
openclaw gateway install
```

Hoặc:

```
openclaw configure
```

Khi được nhắc, chọn **Gateway service**.

Sửa chữa/di chuyển:

```
openclaw doctor
```

## Điều khiển hệ thống (systemd user unit)

OpenClaw installs a systemd **user** service by default. Use a **system**
service for shared or always-on servers. The full unit example and guidance
live in the [Gateway runbook](/gateway).

Thiết lập tối thiểu:

Tạo `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Kích hoạt:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
