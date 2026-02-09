---
summary: "Các bước ký cho các bản build debug macOS được tạo bởi các script đóng gói"
read_when:
  - Khi build hoặc ký các bản build debug mac
title: "Ký macOS"
---

# ký mac (bản build debug)

Ứng dụng này thường được build từ [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), script hiện nay:

- đặt một bundle identifier debug ổn định: `ai.openclaw.mac.debug`
- ghi Info.plist với bundle id đó (có thể ghi đè qua `BUNDLE_ID=...`)
- calls [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) to sign the main binary and app bundle so macOS treats each rebuild as the same signed bundle and keeps TCC permissions (notifications, accessibility, screen recording, mic, speech). mặc định dùng `CODESIGN_TIMESTAMP=auto`; nó bật trusted timestamps cho chữ ký Developer ID.
- uses `CODESIGN_TIMESTAMP=auto` by default; it enables trusted timestamps for Developer ID signatures. Đặt `CODESIGN_TIMESTAMP=off` để bỏ qua việc đóng dấu thời gian (các bản build debug ngoại tuyến).
- chèn metadata build vào Info.plist: `OpenClawBuildTimestamp` (UTC) và `OpenClawGitCommit` (hash ngắn) để bảng About có thể hiển thị build, git, và kênh debug/release.
- **Đóng gói yêu cầu Node 22+**: script chạy các bản build TS và build Control UI.
- Thêm `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (hoặc chứng chỉ Developer ID Application của bạn) vào shell rc để luôn ký bằng chứng chỉ của bạn. Ký ad-hoc yêu cầu opt-in rõ ràng qua `ALLOW_ADHOC_SIGNING=1` hoặc `SIGN_IDENTITY="-"` (không khuyến nghị cho việc kiểm thử quyền). Ad-hoc signing requires explicit opt-in via `ALLOW_ADHOC_SIGNING=1` or `SIGN_IDENTITY="-"` (not recommended for permission testing).
- runs a Team ID audit after signing and fails if any Mach-O inside the app bundle is signed by a different Team ID. Set `SKIP_TEAM_ID_CHECK=1` to bypass.

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

Điều này là cần thiết để tránh crash khi ứng dụng cố tải các framework nhúng (như Sparkle) không dùng chung Team ID. This is necessary to prevent crashes when the app attempts to load embedded frameworks (like Sparkle) that do not share the same Team ID. Ad-hoc signatures also break TCC permission persistence; see [macOS permissions](/platforms/mac/permissions) for recovery steps.

## Metadata build cho About

`package-mac-app.sh` đóng dấu bundle với:

- `OpenClawBuildTimestamp`: ISO8601 UTC tại thời điểm đóng gói
- `OpenClawGitCommit`: hash git ngắn (hoặc `unknown` nếu không có)

The About tab reads these keys to show version, build date, git commit, and whether it’s a debug build (via `#if DEBUG`). Run the packager to refresh these values after code changes.

## Lý do

TCC permissions are tied to the bundle identifier _and_ code signature. Unsigned debug builds with changing UUIDs were causing macOS to forget grants after each rebuild. Signing the binaries (ad‑hoc by default) and keeping a fixed bundle id/path (`dist/OpenClaw.app`) preserves the grants between builds, matching the VibeTunnel approach.
