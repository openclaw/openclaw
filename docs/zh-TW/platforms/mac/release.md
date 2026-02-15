---
summary: "OpenClaw macOS 發布檢查清單（Sparkle feed、封裝、簽署）"
read_when:
  - 建立或驗證 OpenClaw macOS 發布版本
  - 更新 Sparkle appcast 或 feed 資產
title: "macOS 發布"
---

# OpenClaw macOS 發布 (Sparkle)

此應用程式現在支援 Sparkle 自動更新。發布建置版本必須經過 Developer ID 簽署、壓縮，並隨附已簽署的 appcast 項目發布。

## 前置作業

- 已安裝 Developer ID Application 憑證（例如：`Developer ID Application: <Developer Name> (<TEAMID>)`）。
- Sparkle 私鑰路徑已設定在環境變數 `SPARKLE_PRIVATE_KEY_FILE` 中（指向您的 Sparkle ed25519 私鑰；公鑰已內置於 Info.plist）。如果缺失，請檢查 `~/.profile`。
- 若需要符合 Gatekeeper 安全規範的 DMG/zip 分發，需具備 `xcrun notarytool` 的公證憑證（Keychain 設定檔或 API 金鑰）。
  - 我們使用名為 `openclaw-notary` 的 Keychain 設定檔，這是從您 shell profile 中的 App Store Connect API 金鑰環境變數建立的：
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- 已安裝 `pnpm` 相依項目（`pnpm install --config.node-linker=hoisted`）。
- Sparkle 工具會透過 SwiftPM 自動取得，路徑為 `apps/macos/.build/artifacts/sparkle/Sparkle/bin/`（包含 `sign_update`, `generate_appcast` 等）。

## 建置與封裝

注意事項：

- `APP_BUILD` 對應到 `CFBundleVersion`/`sparkle:version`；請保持為數值且單調遞增（不要包含 `-beta`），否則 Sparkle 會將其視為相同版本。
- 預設為目前的架構（`$(uname -m)`）。若要進行發布/通用建置，請設定 `BUILD_ARCHS="arm64 x86_64"`（或 `BUILD_ARCHS=all`）。
- 使用 `scripts/package-mac-dist.sh` 產生發布產物（zip + DMG + 公證）。使用 `scripts/package-mac-app.sh` 進行本地/開發封裝。

```bash
# 從儲存庫根目錄執行；設定發布 ID 以啟用 Sparkle feed
# APP_BUILD 必須是數值且單調遞增，以便 Sparkle 進行比較
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.13 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# 壓縮以供分發（包含支援 Sparkle 增量更新的資源分叉）
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.13.zip

# 選用：同時為一般使用者建置樣式化的 DMG（拖移至 /Applications）
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.13.dmg

# 推薦：建置 + 公證/釘裝 zip + DMG
# 首先，建立一次 Keychain 設定檔：
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.13 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# 選用：隨發布版本附帶 dSYM
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.13.dSYM.zip
```

## Appcast 項目

使用版本說明產生器，讓 Sparkle 渲染格式化的 HTML 說明：

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.13.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

這會從 `CHANGELOG.md` 產生 HTML 版本說明（透過 [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)），並將其嵌入 appcast 項目中。
發布時，請將更新後的 `appcast.xml` 與發布資產（zip + dSYM）一同提交。

## 發布與驗證

- 將 `OpenClaw-2026.2.13.zip`（以及 `OpenClaw-2026.2.13.dSYM.zip`）上傳到標籤為 `v2026.2.13` 的 GitHub release。
- 確保原始 appcast URL 與內置的 feed 一致：`https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`。
- 完整性檢查：
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` 應回傳 200。
  - 資產上傳後，`curl -I <enclosure url>` 應回傳 200。
  - 在之前的公開建置版本上，從「關於」分頁執行「檢查更新…」，並驗證 Sparkle 是否能順利安裝新版本。

完成定義：已發布簽署過的應用程式與 appcast，更新流程可從舊有的安裝版本正常運作，且發布產物已附加至 GitHub release。
