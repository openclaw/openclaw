---
summary: "Tổng quan hỗ trợ nền tảng (Gateway + ứng dụng đồng hành)"
read_when:
  - Tìm hỗ trợ hệ điều hành hoặc đường dẫn cài đặt
  - Quyết định nơi chạy Gateway
title: "Nền tảng"
---

# Nền tảng

47. OpenClaw core được viết bằng TypeScript. 48. **Node là runtime được khuyến nghị**.
48. Bun không được khuyến nghị cho Gateway (lỗi WhatsApp/Telegram).

50. Có các ứng dụng companion cho macOS (ứng dụng menu bar) và các node di động (iOS/Android). Windows and
    Linux companion apps are planned, but the Gateway is fully supported today.
    Native companion apps for Windows are also planned; the Gateway is recommended via WSL2.

## Chọn hệ điều hành của bạn

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS & hosting

- VPS hub: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS proxy): [exe.dev](/install/exe-dev)

## Liên kết thường dùng

- Hướng dẫn cài đặt: [Bắt đầu](/start/getting-started)
- Runbook Gateway: [Gateway](/gateway)
- Cấu hình Gateway: [Cấu hình](/gateway/configuration)
- Trạng thái dịch vụ: `openclaw gateway status`

## Cài đặt dịch vụ Gateway (CLI)

Sử dụng một trong các cách sau (đều được hỗ trợ):

- Trình hướng dẫn (khuyến nghị): `openclaw onboard --install-daemon`
- Trực tiếp: `openclaw gateway install`
- Luồng cấu hình: `openclaw configure` → chọn **Gateway service**
- Sửa chữa/di chuyển: `openclaw doctor` (đề xuất cài đặt hoặc sửa dịch vụ)

Đích dịch vụ phụ thuộc vào hệ điều hành:

- macOS: LaunchAgent (`bot.molt.gateway` or `bot.molt.<profile>`; legacy `com.openclaw.*`)
- Linux/WSL2: systemd user service (`openclaw-gateway[-<profile>].service`)
