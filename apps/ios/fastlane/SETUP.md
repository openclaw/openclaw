# fastlane 设置（OpenClaw iOS）

安装：

```bash
brew install fastlane
```

创建 App Store Connect API 密钥：

- App Store Connect → 用户和访问 → 密钥 → App Store Connect API → 生成 API 密钥
- 下载 `.p8`，记下 **Issuer ID** 和 **Key ID**

推荐（macOS）：将私钥存储在 Keychain 中，编写非密钥变量：

```bash
scripts/ios-asc-keychain-setup.sh \
  --key-path /absolute/path/to/AuthKey_XXXXXXXXXX.p8 \
  --issuer-id YOUR_ISSUER_ID \
  --write-env
```

这会将这些认证变量写入 `apps/ios/fastlane/.env`：

```bash
ASC_KEY_ID=YOUR_KEY_ID
ASC_ISSUER_ID=YOUR_ISSUER_ID
ASC_KEYCHAIN_SERVICE=openclaw-asc-key
ASC_KEYCHAIN_ACCOUNT=YOUR_MAC_USERNAME
```

重要：`apps/ios/fastlane/.env` 仅用于 Fastlane/App Store Connect 认证和可选的 beta 归档设置。它**不**配置网关侧直接 APNs 推送传递以进行本地 iOS 构建。

可选的应用定位变量（如果 Fastlane 无法通过 bundle 自动解析应用）：

```bash
ASC_APP_IDENTIFIER=ai.openclaw.client
# 或
ASC_APP_ID=YOUR_APP_STORE_CONNECT_APP_ID
```

基于文件的回退（CI/非 macOS）：

```bash
ASC_KEY_ID=YOUR_KEY_ID
ASC_ISSUER_ID=YOUR_ISSUER_ID
ASC_KEY_PATH=/absolute/path/to/AuthKey_XXXXXXXXXX.p8
```

代码签名变量（可选，在 `.env` 中）：

```bash
IOS_DEVELOPMENT_TEAM=YOUR_TEAM_ID
```

提示：从仓库根目录运行 `scripts/ios-team-id.sh` 以打印 Team ID 用于 `.env`。当本地存在时，辅助脚本首选规范 OpenClaw 团队（`Y5PE65HELJ`）；否则首选 Xcode 账户中的第一个非个人团队（然后在需要时使用个人团队）。如果 `IOS_DEVELOPMENT_TEAM` 缺失，Fastlane 自动使用此辅助脚本。

对于保持在直接 APNs 上的本地/手动 iOS 构建，使用 `OPENCLAW_APNS_TEAM_ID`、`OPENCLAW_APNS_KEY_ID` 以及 `OPENCLAW_APNS_PRIVATE_KEY_P8` 或 `OPENCLAW_APNS_PRIVATE_KEY_PATH` 单独配置网关主机。那些网关运行时环境变量与 Fastlane 的 `.env` 是分开的。

验证认证：

```bash
cd apps/ios
fastlane ios auth_check
```

ASC 认证仅在以下情况需要：

- 上传到 TestFlight
- 从 App Store Connect 自动解析下一个构建号

如果您向 `pnpm ios:beta:archive` 传递 `--build-number`，则本地归档路径不需要 ASC 认证。

本地归档不上传：

```bash
pnpm ios:beta:archive
```

上传到 TestFlight：

```bash
pnpm ios:beta
```

直接 Fastlane 入口：

```bash
cd apps/ios
fastlane ios beta
```

在同一 Mac 上全新克隆的维护者恢复路径：

1. 重用该机器上现有的 Keychain 备份 ASC 密钥。
2. 恢复或重新创建 `apps/ios/fastlane/.env`，使其包含非密钥变量：

```bash
ASC_KEY_ID=YOUR_KEY_ID
ASC_ISSUER_ID=YOUR_ISSUER_ID
ASC_KEYCHAIN_SERVICE=openclaw-asc-key
ASC_KEYCHAIN_ACCOUNT=YOUR_MAC_USERNAME
```

3. 重新运行认证验证：

```bash
cd apps/ios
fastlane ios auth_check
```

4. 如果您正在启动全新的生产发布序列，使用以下命令将 iOS 固定到当前网关版本：

```bash
pnpm ios:version:pin -- --from-gateway
```

5. 发布前设置官方/TestFlight 中继 URL：

```bash
export OPENCLAW_PUSH_RELAY_BASE_URL=https://relay.example.com
```

6. 上传：

```bash
pnpm ios:beta
```

上传后快速验证：

- 确认 `apps/ios/build/beta/OpenClaw-<version>.ipa` 存在
- 确认 Fastlane 打印 `Uploaded iOS beta: version=<version> short=<short> build=<build>`
- 记住 TestFlight 处理可能在上传成功后需要几分钟时间

版本规则：

- `apps/ios/version.json` 是固定的 iOS 发布版本源
- `apps/ios/CHANGELOG.md` 是 iOS 专用变更日志和发布说明源
- 支持固定的 iOS 版本使用 CalVer：`YYYY.M.D`
- `pnpm ios:version:pin -- --from-gateway` 将当前根网关版本提升为固定的 iOS 发布版本
- Fastlane 仅使用固定的 iOS 版本；仅更改 `package.json.version` 不会改变 iOS 应用版本
- Fastlane 将 `CFBundleShortVersionString` 设置为固定的 iOS 版本，例如 `2026.4.10`
- Fastlane 将 `CFBundleVersion` 解析为该短版本的下一个整数 TestFlight 构建号
- 更改 `apps/ios/version.json` 或 `apps/ios/CHANGELOG.md` 后运行 `pnpm ios:version:sync`
- `pnpm ios:version:check` 验证签入的 iOS 版本工件是否同步
- Beta 流程在归档前从 `apps/ios/project.yml` 重新生成 `apps/ios/OpenClaw.xcodeproj`
- 本地 beta 签名使用临时生成的 xcconfig，并保留本地开发签名覆盖不变
- 详细工作流程参见 `apps/ios/VERSIONING.md`
