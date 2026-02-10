---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 构建或签名 Mac 调试构建（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: 打包脚本生成的 macOS 调试构建的签名步骤（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: macOS 签名（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-01T21:33:15Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: 403b92f9a0ecdb7cb42ec097c684b7a696be3696d6eece747314a4dc90d8797e（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: platforms/mac/signing.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Mac 签名（调试构建）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
此应用通常从 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 构建，该脚本目前会：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 设置稳定的调试 Bundle 标识符：`ai.openclaw.mac.debug`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 使用该 Bundle ID 写入 Info.plist（可通过 `BUNDLE_ID=...` 覆盖）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 调用 [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) 对主二进制文件和应用包进行签名，使 macOS 将每次重新构建视为相同的已签名包，并保留 TCC 权限（通知、辅助功能、屏幕录制、麦克风、语音）。要获得稳定的权限，请使用真实签名身份；临时签名是可选的且不稳定（参阅 [macOS 权限](/platforms/mac/permissions)）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 默认使用 `CODESIGN_TIMESTAMP=auto`；为 Developer ID 签名启用受信任的时间戳。设置 `CODESIGN_TIMESTAMP=off` 可跳过时间戳（离线调试构建）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 将构建元数据注入 Info.plist：`OpenClawBuildTimestamp`（UTC）和 `OpenClawGitCommit`（短哈希），以便"关于"面板可以显示构建信息、git 信息和调试/发布渠道。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **打包需要 Node 22+**：脚本会运行 TS 构建和 Control UI 构建。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 从环境变量中读取 `SIGN_IDENTITY`。将 `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"`（或你的 Developer ID Application 证书）添加到 shell 配置文件中，以始终使用你的证书签名。临时签名需要通过 `ALLOW_ADHOC_SIGNING=1` 或 `SIGN_IDENTITY="-"` 显式启用（不建议用于权限测试）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 签名后运行 Team ID 审计，如果应用包内的任何 Mach-O 文件由不同的 Team ID 签名则会失败。设置 `SKIP_TEAM_ID_CHECK=1` 可跳过此检查。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 用法（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 从仓库根目录（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/package-mac-app.sh               # 自动选择身份；未找到时报错（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # 真实证书（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # 临时签名（权限不会持久化）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # 显式临时签名（同样的限制）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # 仅限开发的 Sparkle Team ID 不匹配解决方案（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 临时签名注意事项（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
使用 `SIGN_IDENTITY="-"`（临时签名）签名时，脚本会自动禁用**强化运行时**（`--options runtime`）。这是为了防止应用在尝试加载不共享相同 Team ID 的嵌入式框架（如 Sparkle）时崩溃。临时签名还会破坏 TCC 权限持久化；参阅 [macOS 权限](/platforms/mac/permissions) 了解恢复步骤。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 关于面板的构建元数据（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`package-mac-app.sh` 会在包中标记以下信息：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OpenClawBuildTimestamp`：打包时的 ISO8601 UTC 时间（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OpenClawGitCommit`：短 git 哈希（不可用时为 `unknown`）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"关于"选项卡读取这些键以显示版本、构建日期、git 提交以及是否为调试构建（通过 `#if DEBUG`）。代码更改后运行打包程序以刷新这些值。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 原因（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
TCC 权限与 Bundle 标识符*和*代码签名绑定。使用不断变化的 UUID 的未签名调试构建会导致 macOS 在每次重新构建后忘记授权。对二进制文件进行签名（默认临时签名）并保持固定的 Bundle ID/路径（`dist/OpenClaw.app`）可以在构建之间保留授权，与 VibeTunnel 的方案一致。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
