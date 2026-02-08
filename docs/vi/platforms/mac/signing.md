---
summary: "Các bước ký cho các bản build debug macOS được tạo bởi các script đóng gói"
read_when:
  - Khi build hoặc ký các bản build debug mac
title: "Ký macOS"
x-i18n:
  source_path: platforms/mac/signing.md
  source_hash: 403b92f9a0ecdb7c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:44Z
---

# ký mac (bản build debug)

Ứng dụng này thường được build từ [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), script hiện nay:

- đặt một bundle identifier debug ổn định: `ai.openclaw.mac.debug`
- ghi Info.plist với bundle id đó (có thể ghi đè qua `BUNDLE_ID=...`)
- gọi [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) để ký binary chính và app bundle, để macOS coi mỗi lần build lại là cùng một bundle đã ký và giữ các quyền TCC (thông báo, trợ năng, ghi màn hình, mic, giọng nói). Để quyền ổn định, hãy dùng danh tính ký thật; ký ad-hoc là tùy chọn và mong manh (xem [quyền macOS](/platforms/mac/permissions)).
- dùng `CODESIGN_TIMESTAMP=auto` theo mặc định; nó bật trusted timestamps cho chữ ký Developer ID. Đặt `CODESIGN_TIMESTAMP=off` để bỏ timestamping (các bản build debug offline).
- chèn metadata build vào Info.plist: `OpenClawBuildTimestamp` (UTC) và `OpenClawGitCommit` (hash ngắn) để bảng About có thể hiển thị build, git, và kênh debug/release.
- **Đóng gói yêu cầu Node 22+**: script chạy các bản build TS và build Control UI.
- đọc `SIGN_IDENTITY` từ biến môi trường. Thêm `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (hoặc chứng chỉ Developer ID Application của bạn) vào shell rc để luôn ký bằng chứng chỉ của bạn. Ký ad-hoc yêu cầu chủ động bật qua `ALLOW_ADHOC_SIGNING=1` hoặc `SIGN_IDENTITY="-"` (không khuyến nghị cho việc kiểm thử quyền).
- chạy kiểm tra Team ID sau khi ký và sẽ thất bại nếu bất kỳ Mach-O nào trong app bundle được ký bởi một Team ID khác. Đặt `SKIP_TEAM_ID_CHECK=1` để bỏ qua.

## Cách dùng

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Lưu ý về ký ad-hoc

Khi ký với `SIGN_IDENTITY="-"` (ad-hoc), script tự động tắt **Hardened Runtime** (`--options runtime`). Điều này cần thiết để tránh crash khi ứng dụng cố gắng tải các framework nhúng (như Sparkle) không dùng chung Team ID. Chữ ký ad-hoc cũng làm mất khả năng duy trì quyền TCC; xem [quyền macOS](/platforms/mac/permissions) để biết các bước khôi phục.

## Metadata build cho About

`package-mac-app.sh` đóng dấu bundle với:

- `OpenClawBuildTimestamp`: ISO8601 UTC tại thời điểm đóng gói
- `OpenClawGitCommit`: hash git ngắn (hoặc `unknown` nếu không có)

Tab About đọc các khóa này để hiển thị phiên bản, ngày build, commit git, và liệu đây có phải là bản build debug hay không (qua `#if DEBUG`). Hãy chạy lại trình đóng gói để làm mới các giá trị này sau khi thay đổi mã.

## Lý do

Quyền TCC được gắn với bundle identifier _và_ chữ ký mã. Các bản build debug chưa ký với UUID thay đổi đã khiến macOS quên các quyền đã cấp sau mỗi lần build lại. Việc ký các binary (ad-hoc theo mặc định) và giữ bundle id/đường dẫn cố định (`dist/OpenClaw.app`) giúp bảo toàn các quyền giữa các lần build, phù hợp với cách tiếp cận của VibeTunnel.
