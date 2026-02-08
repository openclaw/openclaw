---
summary: "Đăng nhập GitHub Copilot từ OpenClaw bằng quy trình device flow"
read_when:
  - Bạn muốn dùng GitHub Copilot làm nhà cung cấp mô hình
  - Bạn cần quy trình `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
x-i18n:
  source_path: providers/github-copilot.md
  source_hash: 503e0496d92c921e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:52Z
---

# GitHub Copilot

## GitHub Copilot là gì?

GitHub Copilot là trợ lý lập trình AI của GitHub. Nó cung cấp quyền truy cập vào
các mô hình Copilot cho tài khoản và gói GitHub của bạn. OpenClaw có thể dùng
Copilot làm nhà cung cấp mô hình theo hai cách khác nhau.

## Hai cách dùng Copilot trong OpenClaw

### 1) Nhà cung cấp GitHub Copilot tích hợp sẵn (`github-copilot`)

Dùng quy trình đăng nhập thiết bị (device-login) gốc để lấy token GitHub, sau đó
đổi sang token API Copilot khi OpenClaw chạy. Đây là con đường **mặc định** và
đơn giản nhất vì không cần VS Code.

### 2) Plugin Copilot Proxy (`copilot-proxy`)

Dùng tiện ích VS Code **Copilot Proxy** như một cầu nối cục bộ. OpenClaw giao tiếp
với endpoint `/v1` của proxy và dùng danh sách mô hình bạn cấu hình ở đó. Hãy
chọn cách này khi bạn đã chạy Copilot Proxy trong VS Code hoặc cần định tuyến qua nó.
Bạn phải bật plugin và giữ tiện ích VS Code luôn chạy.

Dùng GitHub Copilot làm nhà cung cấp mô hình (`github-copilot`). Lệnh đăng nhập chạy
quy trình device flow của GitHub, lưu hồ sơ xác thực và cập nhật cấu hình để dùng
hồ sơ đó.

## Thiết lập CLI

```bash
openclaw models auth login-github-copilot
```

Bạn sẽ được nhắc truy cập một URL và nhập mã dùng một lần. Giữ terminal mở cho đến
khi hoàn tất.

### Cờ tùy chọn

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Đặt mô hình mặc định

```bash
openclaw models set github-copilot/gpt-4o
```

### Đoạn cấu hình

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Ghi chú

- Yêu cầu TTY tương tác; hãy chạy trực tiếp trong terminal.
- Khả dụng của mô hình Copilot phụ thuộc vào gói của bạn; nếu một mô hình bị từ chối,
  hãy thử ID khác (ví dụ `github-copilot/gpt-4.1`).
- Lần đăng nhập sẽ lưu token GitHub trong kho hồ sơ xác thực và đổi sang token API
  Copilot khi OpenClaw chạy.
