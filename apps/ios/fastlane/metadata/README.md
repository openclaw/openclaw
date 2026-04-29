# App Store 元数据（Fastlane deliver）

此目录由 `fastlane deliver` 用于 App Store Connect 文本元数据。

## 仅上传元数据

```bash
cd apps/ios
ASC_APP_ID=YOUR_APP_STORE_CONNECT_APP_ID \
DELIVER_METADATA=1 fastlane ios metadata
```

## 可选：包含截图

```bash
cd apps/ios
DELIVER_METADATA=1 DELIVER_SCREENSHOTS=1 fastlane ios metadata
```

## 认证

`ios metadata` 通道使用来自 `apps/ios/fastlane/.env` 的 App Store Connect API 密钥认证：

- Keychain 备份（macOS 推荐）：
  - `ASC_KEY_ID`
  - `ASC_ISSUER_ID`
  - `ASC_KEYCHAIN_SERVICE`（默认：`openclaw-asc-key`）
  - `ASC_KEYCHAIN_ACCOUNT`（默认：当前用户）
- 文件/路径回退：
  - `ASC_KEY_ID`
  - `ASC_ISSUER_ID`
  - `ASC_KEY_PATH`

或设置 `APP_STORE_CONNECT_API_KEY_PATH`。

## 说明

- 区域文件位于 `metadata/en-US/` 下。
- `release_notes.txt` 由 `apps/ios/CHANGELOG.md` 生成；更新变更日志后，运行 `pnpm ios:version:sync`。
- 发布说明首先从 `## <固定的 iOS 版本>` 解析，然后在 TestFlight 序列仍在进行时回退到 `## Unreleased`。
- 启动新的生产发布序列时，先使用 `pnpm ios:version:pin -- --from-gateway` 固定 iOS 版本。
- `privacy_url.txt` 设置为 `https://openclaw.ai/privacy`。
- 如果 `deliver` 中的应用查找失败，设置以下之一：
  - `ASC_APP_IDENTIFIER`（bundle ID）
  - `ASC_APP_ID`（数字 App Store Connect 应用 ID，例如来自 `/apps/<id>/...` URL）
- 对于首个应用版本，在 `metadata/review_information/` 下包含审核联系文件：
  - `first_name.txt`
  - `last_name.txt`
  - `email_address.txt`
  - `phone_number.txt`（E.164 格式，例如 `+1 415 555 0100`）
