---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 制作或验证 OpenClaw macOS 发布版本（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 更新 Sparkle appcast 或订阅源资源（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: OpenClaw macOS 发布清单（Sparkle 订阅源、打包、签名）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: macOS 发布（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-01T21:33:17Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: 703c08c13793cd8c96bd4c31fb4904cdf4ffff35576e7ea48a362560d371cb30（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: platforms/mac/release.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenClaw macOS 发布（Sparkle）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
本应用现已支持 Sparkle 自动更新。发布构建必须经过 Developer ID 签名、压缩，并发布包含签名的 appcast 条目。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 前提条件（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 已安装 Developer ID Application 证书（示例：`Developer ID Application: <Developer Name> (<TEAMID>)`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 环境变量 `SPARKLE_PRIVATE_KEY_FILE` 已设置为 Sparkle ed25519 私钥路径（公钥已嵌入 Info.plist）。如果缺失，请检查 `~/.profile`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 用于 `xcrun notarytool` 的公证凭据（钥匙串配置文件或 API 密钥），以实现通过 Gatekeeper 安全分发的 DMG/zip。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 我们使用名为 `openclaw-notary` 的钥匙串配置文件，由 shell 配置文件中的 App Store Connect API 密钥环境变量创建：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `APP_STORE_CONNECT_API_KEY_P8`、`APP_STORE_CONNECT_KEY_ID`、`APP_STORE_CONNECT_ISSUER_ID`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 已安装 `pnpm` 依赖（`pnpm install --config.node-linker=hoisted`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sparkle 工具通过 SwiftPM 自动获取，位于 `apps/macos/.build/artifacts/sparkle/Sparkle/bin/`（`sign_update`、`generate_appcast` 等）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 构建与打包（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
注意事项：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `APP_BUILD` 映射到 `CFBundleVersion`/`sparkle:version`；保持纯数字且单调递增（不含 `-beta`），否则 Sparkle 会将其视为相同版本。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 默认为当前架构（`$(uname -m)`）。对于发布/通用构建，设置 `BUILD_ARCHS="arm64 x86_64"`（或 `BUILD_ARCHS=all`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 使用 `scripts/package-mac-dist.sh` 生成发布产物（zip + DMG + 公证）。使用 `scripts/package-mac-app.sh` 进行本地/开发打包。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 从仓库根目录运行；设置发布 ID 以启用 Sparkle 订阅源。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# APP_BUILD 必须为纯数字且单调递增，以便 Sparkle 正确比较。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BUNDLE_ID=bot.molt.mac \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
APP_VERSION=2026.1.27-beta.1 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
APP_BUILD="$(git rev-list --count HEAD)" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BUILD_CONFIG=release \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/package-mac-app.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 打包用于分发的 zip（包含资源分支以支持 Sparkle 增量更新）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.1.27-beta.1.zip（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 可选：同时构建适合用户使用的样式化 DMG（拖拽到 /Applications）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.1.27-beta.1.dmg（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 推荐：构建 + 公证/装订 zip + DMG（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 首先，创建一次钥匙串配置文件：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#   xcrun notarytool store-credentials "openclaw-notary" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BUNDLE_ID=bot.molt.mac \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
APP_VERSION=2026.1.27-beta.1 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
APP_BUILD="$(git rev-list --count HEAD)" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BUILD_CONFIG=release \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/package-mac-dist.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 可选：随发布一起提供 dSYM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.1.27-beta.1.dSYM.zip（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Appcast 条目（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
使用发布说明生成器，以便 Sparkle 渲染格式化的 HTML 说明：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.1.27-beta.1.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
从 `CHANGELOG.md`（通过 [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)）生成 HTML 发布说明，并将其嵌入 appcast 条目。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
发布时，将更新后的 `appcast.xml` 与发布资源（zip + dSYM）一起提交。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 发布与验证（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 将 `OpenClaw-2026.1.27-beta.1.zip`（和 `OpenClaw-2026.1.27-beta.1.dSYM.zip`）上传到标签 `v2026.1.27-beta.1` 对应的 GitHub 发布。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 确保原始 appcast URL 与内置的订阅源匹配：`https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 完整性检查：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` 返回 200。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `curl -I <enclosure url>` 在资源上传后返回 200。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 在之前的公开构建版本上，从 About 选项卡运行"Check for Updates…"，验证 Sparkle 能正常安装新构建。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
完成定义：已签名的应用 + appcast 已发布，从旧版本的更新流程正常工作，且发布资源已附加到 GitHub 发布。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
