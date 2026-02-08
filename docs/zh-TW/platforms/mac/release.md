---
summary: "OpenClaw macOS 發行檢查清單（Sparkle feed、封裝、簽署）"
read_when:
  - 切版或驗證 OpenClaw macOS 發行版本時
  - 更新 Sparkle appcast 或 feed 資產時
title: "macOS 發行"
x-i18n:
  source_path: platforms/mac/release.md
  source_hash: 98d6640ae4ea9cc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:51Z
---

# OpenClaw macOS 發行（Sparkle）

此應用程式現已提供 Sparkle 自動更新。發行版建置必須以 Developer ID 簽署、壓縮，並以已簽署的 appcast 項目發佈。

## 先決條件

- 已安裝 Developer ID Application 憑證（例如：`Developer ID Application: <Developer Name> (<TEAMID>)`）。
- Sparkle 私鑰路徑已在環境中設定為 `SPARKLE_PRIVATE_KEY_FILE`（指向你的 Sparkle ed25519 私鑰；公鑰已內嵌於 Info.plist）。若缺少，請檢查 `~/.profile`。
- 若要進行 Gatekeeper 安全的 DMG／zip 發佈，需具備 `xcrun notarytool` 的公證（Notary）認證（鑰匙圈設定檔或 API 金鑰）。
  - 我們使用名為 `openclaw-notary` 的鑰匙圈設定檔，該設定檔由 App Store Connect API 金鑰的環境變數在你的 shell 設定檔中建立：
    - `APP_STORE_CONNECT_API_KEY_P8`、`APP_STORE_CONNECT_KEY_ID`、`APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- 已安裝 `pnpm` 相依套件（`pnpm install --config.node-linker=hoisted`）。
- Sparkle 工具會透過 SwiftPM 在 `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` 自動取得（`sign_update`、`generate_appcast` 等）。

## 建置與封裝

注意事項：

- `APP_BUILD` 對應到 `CFBundleVersion`/`sparkle:version`；請維持數值且單調遞增（不要有 `-beta`），否則 Sparkle 會判定為相同版本。
- 預設為目前架構（`$(uname -m)`）。若要發行／通用建置，請設定 `BUILD_ARCHS="arm64 x86_64"`（或 `BUILD_ARCHS=all`）。
- 發行成品（zip + DMG + 公證）請使用 `scripts/package-mac-dist.sh`。本機／開發封裝請使用 `scripts/package-mac-app.sh`。

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

## Appcast 項目

使用發行說明產生器，讓 Sparkle 能渲染格式化的 HTML 說明：

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

此流程會從 `CHANGELOG.md` 產生 HTML 發行說明（透過 [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)），並將其內嵌於 appcast 項目中。
發佈時，請將更新後的 `appcast.xml` 與發行資產（zip + dSYM）一併提交。

## 發佈與驗證

- 將 `OpenClaw-2026.2.6.zip`（以及 `OpenClaw-2026.2.6.dSYM.zip`）上傳到標籤為 `v2026.2.6` 的 GitHub 發行頁。
- 確認原始 appcast URL 與內嵌的 feed 相符：`https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`。
- 基本檢查：
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` 回傳 200。
  - 資產上傳後，`curl -I <enclosure url>` 回傳 200。
  - 在先前的公開版本中，從「關於」分頁執行「檢查更新…」，並確認 Sparkle 能順利安裝新版本。

完成定義：已發佈已簽署的 app 與 appcast、可從較舊的已安裝版本完成更新流程，且發行資產已附加至 GitHub 發行頁。
