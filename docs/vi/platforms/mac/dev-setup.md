---
summary: "Hướng dẫn thiết lập cho lập trình viên làm việc trên ứng dụng OpenClaw macOS"
read_when:
  - Thiết lập môi trường phát triển macOS
title: "Thiết lập Dev macOS"
---

# Thiết lập cho lập trình viên macOS

Hướng dẫn này bao gồm các bước cần thiết để build và chạy ứng dụng OpenClaw macOS từ mã nguồn.

## Điều kiện tiên quyết

Trước khi build ứng dụng, hãy đảm bảo bạn đã cài đặt các thành phần sau:

1. **Xcode 26.2+**: Bắt buộc cho phát triển Swift.
2. **Node.js 22+ & pnpm**: Bắt buộc cho gateway, CLI và các script đóng gói.

## 1) Cài đặt Dependencies

Cài đặt các dependency dùng chung cho toàn bộ dự án:

```bash
pnpm install
```

## 2. Build and Package the App

Để build ứng dụng macOS và đóng gói thành `dist/OpenClaw.app`, chạy:

```bash
./scripts/package-mac-app.sh
```

Nếu bạn không có chứng chỉ Apple Developer ID, script sẽ tự động sử dụng **ad-hoc signing** (`-`).

Để biết các chế độ chạy dev, cờ ký (signing flags) và cách xử lý sự cố Team ID, xem README của ứng dụng macOS:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Lưu ý**: Ứng dụng ký ad-hoc có thể kích hoạt các lời nhắc bảo mật. Nếu ứng dụng crash ngay lập tức với "Abort trap 6", hãy xem mục [Troubleshooting](#troubleshooting).

## 3. Cài đặt CLI

Ứng dụng macOS yêu cầu cài đặt CLI `openclaw` ở phạm vi toàn cục để quản lý các tác vụ nền.

**Để cài đặt (khuyến nghị):**

1. Mở ứng dụng OpenClaw.
2. Vào tab cài đặt **General**.
3. Nhấp **"Install CLI"**.

Hoặc, cài đặt thủ công:

```bash
npm install -g openclaw@<version>
```

## Xử lý sự cố

### Build thất bại: Không khớp toolchain hoặc SDK

Quá trình build ứng dụng macOS yêu cầu macOS SDK mới nhất và toolchain Swift 6.2.

**Các dependency hệ thống (bắt buộc):**

- **Phiên bản macOS mới nhất có sẵn trong Software Update** (được yêu cầu bởi SDK Xcode 26.2)
- **Xcode 26.2** (toolchain Swift 6.2)

**Kiểm tra:**

```bash
xcodebuild -version
xcrun swift --version
```

Nếu các phiên bản không khớp, hãy cập nhật macOS/Xcode và chạy lại quá trình build.

### Ứng dụng crash khi cấp quyền

Nếu ứng dụng bị crash khi bạn cho phép quyền **Speech Recognition** hoặc **Microphone**, nguyên nhân có thể là cache TCC bị hỏng hoặc chữ ký ứng dụng không khớp.

**Cách khắc phục:**

1. Reset quyền TCC:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Nếu vẫn không được, hãy tạm thời thay đổi `BUNDLE_ID` trong [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) để buộc macOS tạo một trạng thái "sạch" hoàn toàn.

### Gateway hiển thị "Starting..." mãi

Nếu trạng thái gateway luôn ở "Starting...", hãy kiểm tra xem có tiến trình zombie nào đang chiếm cổng hay không:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

If a manual run is holding the port, stop that process (Ctrl+C). Như một biện pháp cuối cùng, hãy kill PID bạn đã tìm ở trên.
