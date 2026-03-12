---
read_when:
  - 你遇到连接/认证问题，需要引导式修复
  - 你更新后想进行完整性检查
summary: "`openclaw doctor` 的 CLI 参考（健康检查 + 引导式修复）"
title: doctor
x-i18n:
  generated_at: "2026-02-03T10:04:15Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 92310aa3f3d111e91a74ce1150359d5d8a8d70a856666d9419e16c60d78209f2
  source_path: cli/doctor.md
  workflow: 15
---

# `openclaw doctor`

Gateway 网关和渠道的健康检查 + 快速修复。

相关内容：

- 故障排除：[故障排除](/gateway/troubleshooting)
- 安全审计：[安全](/gateway/security)

## 示例

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

注意事项：

- 交互式提示（如钥匙串/OAuth 修复）仅在 stdin 是 TTY 且**未**设置 `--non-interactive` 时运行。无头运行（cron、Telegram、无终端）将跳过提示。
- `--fix`（`--repair` 的别名）会将备份写入 `~/.openclaw/openclaw.json.bak`，并删除未知的配置键，同时列出每个删除项。

## macOS：`launchctl` 环境变量覆盖

如果你之前运行过 `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...`（或 `...PASSWORD`），该值会覆盖你的配置文件，并可能导致持续的"未授权"错误。

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
