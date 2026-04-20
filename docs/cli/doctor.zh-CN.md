---
summary: "`openclaw doctor`的CLI参考（健康检查 + 引导修复）"
read_when:
  - 您有连接/认证问题并希望获得引导修复
  - 您更新了系统并想要进行健全性检查
title: "doctor"
---

# `openclaw doctor`

Gateway和通道的健康检查 + 快速修复。

相关：

- 故障排除：[Troubleshooting](/gateway/troubleshooting)
- 安全审计：[Security](/gateway/security)

## 示例

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
openclaw doctor --repair --non-interactive
openclaw doctor --generate-gateway-token
```

## 选项

- `--no-workspace-suggestions`: 禁用工作区内存/搜索建议
- `--yes`: 接受默认值而不提示
- `--repair`: 应用推荐的修复而不提示
- `--fix`: `--repair`的别名
- `--force`: 应用激进的修复，包括在需要时覆盖自定义服务配置
- `--non-interactive`: 运行时不提示；仅安全迁移
- `--generate-gateway-token`: 生成并配置gateway令牌
- `--deep`: 扫描系统服务以查找额外的gateway安装

注意事项：

- 交互式提示（如钥匙串/OAuth修复）仅在stdin是TTY且**未**设置`--non-interactive`时运行。无头运行（cron、Telegram、无终端）会跳过提示。
- `--fix`（`--repair`的别名）将备份写入`~/.openclaw/openclaw.json.bak`并删除未知的配置键，列出每次删除。
- 状态完整性检查现在检测会话目录中的孤立记录文件，并可以将它们存档为`.deleted.<timestamp>`以安全地回收空间。
- Doctor还扫描`~/.openclaw/cron/jobs.json`（或`cron.store`）以查找遗留的cron作业形状，并可以在调度器必须在运行时自动规范化它们之前就地重写它们。
- Doctor自动将遗留的扁平Talk配置（`talk.voiceId`、`talk.modelId`等）迁移到`talk.provider` + `talk.providers.<provider>`。
- 重复运行`doctor --fix`不再报告/应用Talk规范化，当唯一的区别是对象键顺序时。
- Doctor包括内存搜索就绪性检查，当缺少嵌入凭据时可以推荐`openclaw configure --section model`。
- 如果启用了沙箱模式但Docker不可用，doctor会报告一个高信号警告并提供补救措施（`install Docker`或`openclaw config set agents.defaults.sandbox.mode off`）。
- 如果`gateway.auth.token`/`gateway.auth.password`由SecretRef管理且在当前命令路径中不可用，doctor会报告只读警告，不会写入明文回退凭据。
- 如果通道SecretRef检查在修复路径中失败，doctor会继续并报告警告，而不是提前退出。
- Telegram `allowFrom`用户名自动解析（`doctor --fix`）需要在当前命令路径中可解析的Telegram令牌。如果令牌检查不可用，doctor会报告警告并跳过该次自动解析。

## macOS: `launchctl` env覆盖

如果您之前运行了`launchctl setenv OPENCLAW_GATEWAY_TOKEN ...`（或`...PASSWORD`），该值会覆盖您的配置文件并可能导致持续的"未授权"错误。

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```