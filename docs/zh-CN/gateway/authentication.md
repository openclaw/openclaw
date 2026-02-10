---
read_when:
  - 调试模型认证或 OAuth 过期
  - 记录认证或凭证存储
summary: 模型认证：OAuth、API 密钥和 setup-token
title: 认证
x-i18n:
  generated_at: "2026-02-03T07:47:32Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 66fa2c64ff374c9cfcdb4e7a951b0d164d512295e65513eb682f12191b75e557
  source_path: gateway/authentication.md
  workflow: 15
---

# 认证

OpenClaw 支持模型提供商的 OAuth 和 API 密钥。对于 Anthropic 账户，我们推荐使用 **API 密钥**。对于 Claude 订阅访问，使用 `claude setup-token` 创建的长期令牌。

参阅 [/concepts/oauth](/concepts/oauth) 了解完整的 OAuth 流程和存储布局。

## 推荐的 Anthropic 设置（API 密钥）

如果你直接使用 Anthropic，请使用 API 密钥。

1. 在 Anthropic 控制台创建 API 密钥。
2. 将其放在 **Gateway 网关主机**（运行 `openclaw gateway` 的机器）上。

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. 如果 Gateway 网关在 systemd/launchd 下运行，最好将密钥放在 `~/.openclaw/.env` 中以便守护进程可以读取：

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

然后重启守护进程（或重启你的 Gateway 网关进程）并重新检查：

```bash
openclaw models status
openclaw doctor
```

如果你不想自己管理环境变量，新手引导向导可以为守护进程使用存储 API 密钥：`openclaw onboard`。

参阅[帮助](/help)了解环境变量继承的详情（`env.shellEnv`、`~/.openclaw/.env`、systemd/launchd）。

## Anthropic：setup-token（订阅认证）

对于 Anthropic，推荐的路径是 **API 密钥**。如果你使用 Claude 订阅，也支持 setup-token 流程。在 **Gateway 网关主机**上运行：

```bash
claude setup-token
```

然后将其粘贴到 OpenClaw：

```bash
openclaw models auth setup-token --provider anthropic
```

如果令牌是在另一台机器上创建的，手动粘贴：

```bash
openclaw models auth paste-token --provider anthropic
```

如果你看到类似这样的 Anthropic 错误：

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…请改用 Anthropic API 密钥。

手动令牌输入（任何提供商；写入 `auth-profiles.json` + 更新配置）：

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

自动化友好检查（过期/缺失时退出 `1`，即将过期时退出 `2`）：

```bash
openclaw models status --check
```

可选的运维脚本（systemd/Termux）在此处记录：[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` 需要交互式 TTY。

## 检查模型认证状态

```bash
openclaw models status
openclaw doctor
```

## 控制使用哪个凭证

### 每会话（聊天命令）

使用 `/model <alias-or-id>@<profileId>` 为当前会话固定特定的提供商凭证（示例配置文件 ID：`anthropic:default`、`anthropic:work`）。

使用 `/model`（或 `/model list`）获取紧凑的选择器；使用 `/model status` 获取完整视图（候选项 + 下一个认证配置文件，以及配置时的提供商端点详情）。

### 每智能体（CLI 覆盖）

为智能体设置显式的认证配置文件顺序覆盖（存储在该智能体的 `auth-profiles.json` 中）：

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

使用 `--agent <id>` 指定特定智能体；省略它则使用配置的默认智能体。

## 故障排除

### "No credentials found"

如果 Anthropic 令牌配置文件缺失，在 **Gateway 网关主机**上运行 `claude setup-token`，然后重新检查：

```bash
openclaw models status
```

### 令牌即将过期/已过期

运行 `openclaw models status` 确认哪个配置文件即将过期。如果配置文件缺失，重新运行 `claude setup-token` 并再次粘贴令牌。

## 要求

- Claude Max 或 Pro 订阅（用于 `claude setup-token`）
- 已安装 Claude Code CLI（`claude` 命令可用）
