---
summary: "Hỗ trợ Linux + trạng thái ứng dụng đồng hành"
read_when:
  - Tìm trạng thái ứng dụng đồng hành trên Linux
  - Lập kế hoạch phạm vi nền tảng hoặc đóng góp
title: "Ứng dụng Linux"
x-i18n:
  source_path: platforms/linux.md
  source_hash: 93b8250cd1267004
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:34Z
---

# Ứng dụng Linux

Gateway được hỗ trợ đầy đủ trên Linux. **Node là runtime được khuyến nghị**.
Không khuyến nghị dùng Bun cho Gateway (lỗi WhatsApp/Telegram).

Các ứng dụng đồng hành Linux gốc đang được lên kế hoạch. Hoan nghênh đóng góp nếu bạn muốn giúp xây dựng.

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

OpenClaw mặc định cài đặt một dịch vụ systemd **user**. Dùng dịch vụ **system**
cho máy chủ dùng chung hoặc luôn bật. Ví dụ unit đầy đủ và hướng dẫn
có trong [runbook Gateway](/gateway).

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
