---
summary: "Plugin Zalo Personal: đăng nhập QR + nhắn tin qua zca-cli (cài plugin + cấu hình kênh + CLI + công cụ)"
read_when:
  - Bạn muốn hỗ trợ Zalo Personal (không chính thức) trong OpenClaw
  - Bạn đang cấu hình hoặc phát triển plugin zalouser
title: "Plugin Zalo Personal"
---

# Zalo Personal (plugin)

Hỗ trợ Zalo Personal cho OpenClaw thông qua một plugin, sử dụng `zca-cli` để tự động hóa một tài khoản người dùng Zalo thông thường.

> **Warning:** Unofficial automation may lead to account suspension/ban. Use at your own risk.

## Đặt tên

Channel id is `zalouser` to make it explicit this automates a **personal Zalo user account** (unofficial). We keep `zalo` reserved for a potential future official Zalo API integration.

## Nơi chạy

Plugin này chạy **bên trong tiến trình Gateway**.

Nếu bạn dùng Gateway từ xa, hãy cài đặt/cấu hình nó trên **máy đang chạy Gateway**, sau đó khởi động lại Gateway.

## Cài đặt

### Tùy chọn A: cài từ npm

```bash
openclaw plugins install @openclaw/zalouser
```

Sau đó khởi động lại Gateway.

### Tùy chọn B: cài từ thư mục cục bộ (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Sau đó khởi động lại Gateway.

## Điều kiện tiên quyết: zca-cli

Máy Gateway phải có `zca` trên `PATH`:

```bash
zca --version
```

## Cấu hình

Cấu hình kênh nằm dưới `channels.zalouser` (không phải `plugins.entries.*`):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## Công cụ của tác tử

Tên công cụ: `zalouser`

Hành động: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
