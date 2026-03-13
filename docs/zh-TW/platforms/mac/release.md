---
summary: "OpenClaw macOS release checklist (Sparkle feed, packaging, signing)"
read_when:
  - Cutting or validating a OpenClaw macOS release
  - Updating the Sparkle appcast or feed assets
title: macOS Release
---

# OpenClaw macOS 發行版（Sparkle）

此應用程式現在支援 Sparkle 自動更新。發行版本必須使用 Developer ID 簽署，壓縮成 zip，並以簽署過的 appcast 條目發布。

## 前置需求

- 已安裝 Developer ID Application 證書（範例：`Developer ID Application: <Developer Name> (<TEAMID>)`）。
- Sparkle 私鑰路徑需設定在環境變數中，為 `SPARKLE_PRIVATE_KEY_FILE`（指向你的 Sparkle ed25519 私鑰路徑；公鑰已內嵌於 Info.plist）。若缺少，請檢查 `~/.profile`。
- 若要發佈 Gatekeeper 安全的 DMG/zip，需有 Notary 認證（鑰匙圈設定檔或 API 金鑰）對應 `xcrun notarytool`。
  - 我們使用名為 `openclaw-notary` 的鑰匙圈設定檔，該設定檔是從 App Store Connect API 金鑰環境變數在你的 shell 設定中建立：
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- 已安裝 `pnpm` 依賴 (`pnpm install --config.node-linker=hoisted`)。
- Sparkle 工具會透過 SwiftPM 自動取得，位置在 `apps/macos/.build/artifacts/sparkle/Sparkle/bin/`（包含 `sign_update`, `generate_appcast` 等）。

## 建置與打包

注意事項：

- `APP_BUILD` 對應 `CFBundleVersion`/`sparkle:version`；請保持為數字且單調遞增（不可有 `-beta`），否則 Sparkle 會視為相等。
- 若省略 `APP_BUILD`，`scripts/package-mac-app.sh` 會從 `APP_VERSION` 自動推導出 Sparkle 安全的預設值（`YYYYMMDDNN`：穩定版預設為 `90`，預發佈版則使用後綴衍生的路線），並取該值與 git commit 數的較大者。
- 當發行工程需要特定單調值時，仍可明確覆寫 `APP_BUILD`。
- 對於 `BUILD_CONFIG=release`，`scripts/package-mac-app.sh` 現在預設為 universal (`arm64 x86_64`)。你仍可用 `BUILD_ARCHS=arm64` 或 `BUILD_ARCHS=x86_64` 覆寫。對於本地/開發建置（`BUILD_CONFIG=debug`），預設為當前架構 (`$(uname -m)`)。
- 發行產物（zip + DMG + 公證）請使用 `scripts/package-mac-dist.sh`。本地/開發打包請使用 `scripts/package-mac-app.sh`。

bash

# 從專案根目錄執行；設定發行 ID 以啟用 Sparkle 更新源。

# 此指令建置發行產物但不進行公證。

# APP_BUILD 必須為數字且單調遞增以供 Sparkle 比較。

# 預設會從 APP_VERSION 自動推導。

SKIP_NOTARIZE=1 \
BUNDLE_ID=ai.openclaw.mac \
APP_VERSION=2026.3.12 \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

bash

# `package-mac-dist.sh` 已經會建立 zip + DMG。

# 若你直接使用 `package-mac-app.sh`，則需手動建立：

# 若此步驟想要進行公證/綁定，請使用下方的 NOTARIZE 指令。

ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.3.12.zip

bash

# 選用：為使用者建立有風格的 DMG（可拖曳至 /Applications）

scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.3.12.dmg

bash

# 推薦：建置並公證/綁定 zip + DMG

# 首次建立鑰匙圈設定檔：

# xcrun notarytool store-credentials "openclaw-notary" \

# --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"

NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=ai.openclaw.mac \
APP_VERSION=2026.3.12 \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

bash

# 選用：隨發行版本一併發佈 dSYM

ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.3.12.dSYM.zip

## Appcast 條目

請使用發行說明產生器，讓 Sparkle 呈現格式化的 HTML 說明：

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.3.12.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

從 `CHANGELOG.md` 生成 HTML 發行說明（透過 [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)），並將其嵌入 appcast 條目中。
發布時，將更新後的 `appcast.xml` 與發行資產（zip + dSYM）一併提交。

## 發布與驗證

- 將 `OpenClaw-2026.3.12.zip`（及 `OpenClaw-2026.3.12.dSYM.zip`）上傳至標籤為 `v2026.3.12` 的 GitHub 發行頁面。
- 確認原始 appcast URL 與生成的 feed 相符：`https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`。
- 基本檢查：
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` 回傳 200。
  - 資產上傳後 `curl -I <enclosure url>` 回傳 200。
  - 在先前的公開版本上，從「關於」分頁執行「檢查更新…」，並確認 Sparkle 能順利安裝新版本。

完成定義：已發布簽署過的 app 與 appcast，更新流程能從舊版正常運作，且發行資產已附加至 GitHub 發行頁面。
