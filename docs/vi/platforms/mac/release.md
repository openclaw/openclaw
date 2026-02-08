---
summary: "Danh sách kiểm tra phát hành OpenClaw macOS (Sparkle feed, đóng gói, ký)"
read_when:
  - Cắt hoặc xác thực một bản phát hành OpenClaw macOS
  - Cập nhật Sparkle appcast hoặc các tài sản feed
title: "Phát hành macOS"
x-i18n:
  source_path: platforms/mac/release.md
  source_hash: 98d6640ae4ea9cc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:44Z
---

# Phát hành OpenClaw macOS (Sparkle)

Ứng dụng này hiện có cập nhật tự động bằng Sparkle. Các bản build phát hành phải được ký bằng Developer ID, nén zip và xuất bản kèm một mục appcast đã ký.

## Điều kiện tiên quyết

- Đã cài đặt chứng chỉ Developer ID Application (ví dụ: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Đã đặt đường dẫn khóa riêng Sparkle trong biến môi trường là `SPARKLE_PRIVATE_KEY_FILE` (đường dẫn tới khóa riêng ed25519 của Sparkle; khóa công khai được nhúng trong Info.plist). Nếu thiếu, hãy kiểm tra `~/.profile`.
- Thông tin xác thực Notary (hồ sơ keychain hoặc khóa API) cho `xcrun notarytool` nếu bạn muốn phân phối DMG/zip an toàn với Gatekeeper.
  - Chúng tôi dùng một hồ sơ Keychain tên `openclaw-notary`, được tạo từ các biến môi trường khóa API App Store Connect trong shell profile của bạn:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- Đã cài các phụ thuộc `pnpm` (`pnpm install --config.node-linker=hoisted`).
- Công cụ Sparkle được tải tự động qua SwiftPM tại `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast`, v.v.).

## Build & đóng gói

Ghi chú:

- `APP_BUILD` ánh xạ tới `CFBundleVersion`/`sparkle:version`; hãy giữ dạng số và tăng dần (không có `-beta`), nếu không Sparkle sẽ so sánh là bằng nhau.
- Mặc định theo kiến trúc hiện tại (`$(uname -m)`). Với các bản build phát hành/universal, đặt `BUILD_ARCHS="arm64 x86_64"` (hoặc `BUILD_ARCHS=all`).
- Dùng `scripts/package-mac-dist.sh` cho các artefact phát hành (zip + DMG + notarization). Dùng `scripts/package-mac-app.sh` cho đóng gói local/dev.

```bash
# From repo root; set release IDs so Sparkle feed is enabled.
# APP_BUILD must be numeric + monotonic for Sparkle compare.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.6 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# Zip for distribution (includes resource forks for Sparkle delta support)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.6.zip

# Optional: also build a styled DMG for humans (drag to /Applications)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.6.dmg

# Recommended: build + notarize/staple zip + DMG
# First, create a keychain profile once:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.6 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# Optional: ship dSYM alongside the release
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.6.dSYM.zip
```

## Mục appcast

Dùng trình tạo ghi chú phát hành để Sparkle hiển thị ghi chú HTML được định dạng:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

Tạo ghi chú phát hành HTML từ `CHANGELOG.md` (qua [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) và nhúng chúng vào mục appcast.
Commit `appcast.xml` đã cập nhật cùng với các tài sản phát hành (zip + dSYM) khi xuất bản.

## Xuất bản & xác minh

- Tải lên `OpenClaw-2026.2.6.zip` (và `OpenClaw-2026.2.6.dSYM.zip`) vào bản phát hành GitHub cho thẻ `v2026.2.6`.
- Đảm bảo URL appcast raw khớp với feed đã nhúng: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- Kiểm tra nhanh:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` trả về 200.
  - `curl -I <enclosure url>` trả về 200 sau khi tải lên tài sản.
  - Trên một bản public trước đó, chạy “Check for Updates…” từ thẻ About và xác minh Sparkle cài đặt bản build mới sạch sẽ.

Định nghĩa hoàn tất: ứng dụng đã ký + appcast được xuất bản, luồng cập nhật hoạt động từ một phiên bản cũ đã cài đặt, và các tài sản phát hành được đính kèm vào bản phát hành GitHub.
