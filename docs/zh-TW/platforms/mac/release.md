---
summary: "OpenClaw macOS 發行檢查清單 (Sparkle 更新來源、打包、簽署)"
read_when:
  - 發布或驗證 OpenClaw macOS 發行版時
  - 更新 Sparkle appcast 或更新來源資產時
title: "macOS 發行"
---

# OpenClaw macOS 發行 (Sparkle)

此應用程式現在支援 Sparkle 自動更新。發行版本必須經過 Developer ID 簽署、壓縮，並隨附簽署的 appcast 條目發布。

## 必要條件

- 已安裝 Developer ID 應用程式憑證 (範例：`Developer ID Application: <開發者名稱> (<團隊ID>)`)。
- Sparkle 私鑰路徑已在環境中設定為 `SPARKLE_PRIVATE_KEY_FILE` (您的 Sparkle ed25519 私鑰路徑；公鑰已嵌入 Info.plist 中)。如果遺失，請檢查 `~/.profile`。
- 如果您需要支援 Gatekeeper 的 DMG/zip 發布，請準備 `xcrun notarytool` 的公證憑證 (鑰匙圈設定檔或 API 金鑰)。
  - 我們使用一個名為 `openclaw-notary` 的鑰匙圈設定檔，它是根據您 Shell 設定檔中的 App Store Connect API 金鑰環境變數建立的：
    - `APP_STORE_CONNECT_API_KEY_P8`、`APP_STORE_CONNECT_KEY_ID`、`APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- 已安裝 `pnpm` 依賴項 (`pnpm install --config.node-linker=hoisted`)。
- Sparkle 工具會透過 SwiftPM 自動從 `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` 獲取 (`sign_update`、`generate_appcast` 等)。

## 建置與打包

注意事項：

- `APP_BUILD` 對應到 `CFBundleVersion`/`sparkle:version`；請保持為數字且單調遞增 (無 `-beta`)，否則 Sparkle 會將其視為相同。
- 預設為目前架構 (`$(uname -m)`)。對於發行/通用版本，請設定 `BUILD_ARCHS="arm64 x86_64"` (或 `BUILD_ARCHS=all`)。
- 使用 `scripts/package-mac-dist.sh` 進行發行版檔案 (zip + DMG + 公證)。使用 `scripts/package-mac-app.sh` 進行本地/開發打包。

```bash
# From repo root; set release IDs so Sparkle feed is enabled.
# APP_BUILD must be numeric + monotonic for Sparkle compare.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.13 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# Zip for distribution (includes resource forks for Sparkle delta support)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.13.zip

# Optional: also build a styled DMG for humans (drag to /Applications)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.13.dmg

# Recommended: build + notarize/staple zip + DMG
# First, create a keychain profile once:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.13 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# Optional: ship dSYM alongside the release
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.13.dSYM.zip
```

## Appcast 條目

使用發行說明產生器，讓 Sparkle 呈現格式化的 HTML 說明：

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.13.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

從 `CHANGELOG.md` 產生 HTML 發行說明 (透過 [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh))，並將其嵌入 appcast 條目中。
發布時，請將更新後的 `appcast.xml` 與發行版資產 (zip + dSYM) 一同提交。

## 發布與驗證

- 將 `OpenClaw-2026.2.13.zip` (和 `OpenClaw-2026.2.13.dSYM.zip`) 上傳到 GitHub 發行版的標籤 `v2026.2.13`。
- 確保原始 appcast URL 與內建的更新來源相符：`https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`。
- 基本檢查：
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` 返回 200。
  - 資產上傳後，`curl -I <enclosure url>` 返回 200。
  - 在之前的公開版本上，從「關於」分頁執行「檢查更新…」並驗證 Sparkle 是否乾淨地安裝了新版本。

完成定義：簽署的應用程式 + appcast 已發布，更新流程可從較舊的安裝版本運作，並且發行版資產已附加到 GitHub 發行版中。
