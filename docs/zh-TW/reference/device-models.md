---
summary: >-
  How OpenClaw vendors Apple device model identifiers for friendly names in the
  macOS app.
read_when:
  - Updating device model identifier mappings or NOTICE/license files
  - Changing how Instances UI displays device names
title: Device Model Database
---

# 裝置型號資料庫（友善名稱）

macOS 伴隨應用程式會在 **Instances** 介面中顯示友善的 Apple 裝置型號名稱，方法是將 Apple 型號識別碼（例如 `iPad16,6`、`Mac16,6`）對應到易讀的名稱。

此對應關係以 JSON 格式內嵌於：

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## 資料來源

我們目前使用 MIT 授權的專案庫作為對應資料來源：

- `kyle-seongwoo-jun/apple-device-identifiers`

為了保持建置的確定性，JSON 檔案會鎖定到特定的上游提交版本（記錄於 `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`）。

## 更新資料庫

1. 選擇你想鎖定的上游提交版本（iOS 一個，macOS 一個）。
2. 更新 `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` 中的提交哈希值。
3. 重新下載鎖定到這些提交版本的 JSON 檔案：

bash
IOS_COMMIT="<ios-device-identifiers.json 的提交 SHA>"
MAC_COMMIT="<mac-device-identifiers.json 的提交 SHA>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
 -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
 -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json

4. 確認 `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` 仍與上游授權相符（若上游授權變更，請替換）。
5. 驗證 macOS 應用程式能順利編譯且無警告：

```bash
swift build --package-path apps/macos
```
