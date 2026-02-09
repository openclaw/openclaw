---
summary: "Đăng nhập GitHub Copilot từ OpenClaw bằng quy trình device flow"
read_when:
  - Bạn muốn dùng GitHub Copilot làm nhà cung cấp mô hình
  - Bạn cần quy trình `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
---

# GitHub Copilot

## GitHub Copilot là gì?

GitHub Copilot là trợ lý lập trình AI của GitHub. Nó cung cấp quyền truy cập vào các mô hình Copilot
cho tài khoản và gói GitHub của bạn. OpenClaw có thể sử dụng Copilot như một nhà cung cấp mô hình
theo hai cách khác nhau.

## Hai cách dùng Copilot trong OpenClaw

### 1. Nhà cung cấp GitHub Copilot tích hợp sẵn (`github-copilot`)

Sử dụng luồng đăng nhập thiết bị gốc để lấy token GitHub, sau đó trao đổi nó lấy token API Copilot khi OpenClaw chạy. Đây là **mặc định** và con đường đơn giản nhất
vì nó không yêu cầu VS Code.

### 2. Plugin Copilot Proxy (`copilot-proxy`)

Sử dụng tiện ích mở rộng VS Code **Copilot Proxy** làm cầu nối cục bộ. OpenClaw giao tiếp với
endpoint `/v1` của proxy và sử dụng danh sách mô hình bạn cấu hình ở đó. Chọn
cách này khi bạn đã chạy Copilot Proxy trong VS Code hoặc cần định tuyến thông qua nó.
Bạn phải bật plugin và giữ cho tiện ích mở rộng VS Code luôn chạy.

Use GitHub Copilot as a model provider (`github-copilot`). Lệnh đăng nhập chạy
luồng thiết bị GitHub, lưu một hồ sơ xác thực và cập nhật cấu hình của bạn để sử dụng hồ sơ đó.

## Thiết lập CLI

```bash
openclaw models auth login-github-copilot
```

Bạn sẽ được nhắc truy cập một URL và nhập một mã dùng một lần. Giữ terminal
mở cho đến khi hoàn tất.

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
