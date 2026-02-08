---
summary: "Tổng quan hỗ trợ nền tảng (Gateway + ứng dụng đồng hành)"
read_when:
  - Tìm hỗ trợ hệ điều hành hoặc đường dẫn cài đặt
  - Quyết định nơi chạy Gateway
title: "Nền tảng"
x-i18n:
  source_path: platforms/index.md
  source_hash: 959479995f9ecca3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:31Z
---

# Nền tảng

Lõi OpenClaw được viết bằng TypeScript. **Node là runtime được khuyến nghị**.
Bun không được khuyến nghị cho Gateway (lỗi WhatsApp/Telegram).

Ứng dụng đồng hành có sẵn cho macOS (ứng dụng thanh menu) và các node di động (iOS/Android). Ứng dụng đồng hành cho Windows và
Linux đang được lên kế hoạch, nhưng Gateway hiện đã được hỗ trợ đầy đủ.
Ứng dụng đồng hành native cho Windows cũng đang được lên kế hoạch; khuyến nghị chạy Gateway qua WSL2.

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

- macOS: LaunchAgent (`bot.molt.gateway` hoặc `bot.molt.<profile>`; legacy `com.openclaw.*`)
- Linux/WSL2: systemd user service (`openclaw-gateway[-<profile>].service`)
