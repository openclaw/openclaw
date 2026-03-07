---
read_when:
  - 调试缺失或卡住的 macOS 权限提示
  - 打包或签名 macOS 应用
  - 更改 Bundle ID 或应用安装路径
summary: macOS 权限持久化（TCC）和签名要求
title: macOS 权限
x-i18n:
  generated_at: "2026-02-01T21:32:58Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d012589c0583dd0b3792d695f3f71a6ff265704cf02a3b79f8c4a5b14712e6aa
  source_path: platforms/mac/permissions.md
  workflow: 15
---

# macOS 权限（TCC）

macOS 权限授予是脆弱的。TCC 将权限授予与应用的代码签名、Bundle 标识符和磁盘路径关联。如果其中任何一项发生变化，macOS 会将该应用视为新应用，可能会丢弃或隐藏权限提示。

## 稳定权限的要求

- 相同路径：从固定位置运行应用（对于 OpenClaw，为 `dist/OpenClaw.app`）。
- 相同 Bundle 标识符：更改 Bundle ID 会创建新的权限身份。
- 已签名的应用：未签名或临时签名的构建不会持久化权限。
- 一致的签名：使用真实的 Apple Development 或 Developer ID 证书，以确保签名在多次构建之间保持稳定。

临时签名每次构建都会生成新的身份。macOS 会忘记之前的授权，提示可能完全消失，直到清除过期条目为止。

## 权限提示消失时的恢复清单

1. 退出应用。
2. 在系统设置 -> 隐私与安全性中移除该应用条目。
3. 从相同路径重新启动应用并重新授予权限。
4. 如果提示仍未出现，使用 `tccutil` 重置 TCC 条目后重试。
5. 某些权限仅在完全重启 macOS 后才会重新出现。

重置示例（根据需要替换 Bundle ID）：

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

如果你正在测试权限，请始终使用真实证书签名。临时签名的构建仅适用于不需要权限的快速本地运行。
