---
summary: "說明 OpenClaw 如何在 macOS 應用程式中，將 Apple 裝置模型識別碼對應為易讀名稱。"
read_when:
  - 更新裝置模型識別碼對應或 NOTICE／授權檔案時
  - 變更 Instances UI 顯示裝置名稱的方式時
title: "裝置模型資料庫"
---

# Device model database (friendly names)

macOS 配套應用程式會在 **Instances** UI 中，透過將 Apple 模型識別碼（例如 `iPad16,6`、`Mac16,6`）對應為人類可讀的名稱，來顯示易讀的 Apple 裝置模型名稱。

此對應以 JSON 形式隨附，存放於：

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## 資料來源

We currently vendor the mapping from the MIT-licensed repository:

- `kyle-seongwoo-jun/apple-device-identifiers`

為了確保建置具備確定性，JSON 檔案會固定（pin）在特定的上游提交版本（記錄於 `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`）。

## Updating the database

1. 選擇你要固定的上游提交版本（iOS 一個、macOS 一個）。
2. 更新 `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` 中的提交雜湊值。
3. 重新下載固定在這些提交版本的 JSON 檔案：

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. 確保 `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` 仍與上游一致（若上游授權變更，請替換）。
5. 驗證 macOS 應用程式可順利建置（無任何警告）：

```bash
swift build --package-path apps/macos
```
