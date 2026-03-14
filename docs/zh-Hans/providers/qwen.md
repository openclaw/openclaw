---
read_when:
  - 你想在 OpenClaw 中使用 Qwen
  - 你想要免费层 OAuth 访问 Qwen Coder
summary: 在 OpenClaw 中使用 Qwen OAuth（免费层）
title: Qwen
x-i18n:
  generated_at: "2026-02-03T07:53:34Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 88b88e224e2fecbb1ca26e24fbccdbe25609be40b38335d0451343a5da53fdd4
  source_path: providers/qwen.md
  workflow: 15
---

# Qwen

Qwen 为 Qwen Coder 和 Qwen Vision 模型提供免费层 OAuth 流程（每天 2,000 次请求，受 Qwen 速率限制约束）。

## 启用插件

```bash
openclaw plugins enable qwen-portal-auth
```

启用后重启 Gateway 网关。

## 认证

```bash
openclaw models auth login --provider qwen-portal --set-default
```

这会运行 Qwen 设备码 OAuth 流程并将提供商条目写入你的 `models.json`（加上一个 `qwen` 别名以便快速切换）。

## 模型 ID

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

切换模型：

```bash
openclaw models set qwen-portal/coder-model
```

## 复用 Qwen Code CLI 登录

如果你已经使用 Qwen Code CLI 登录，OpenClaw 会在加载认证存储时从 `~/.qwen/oauth_creds.json` 同步凭证。你仍然需要一个 `models.providers.qwen-portal` 条目（使用上面的登录命令创建一个）。

## 注意

- 令牌自动刷新；如果刷新失败或访问被撤销，请重新运行登录命令。
- 默认基础 URL：`https://portal.qwen.ai/v1`（如果 Qwen 提供不同的端点，使用 `models.providers.qwen-portal.baseUrl` 覆盖）。
- 参阅[模型提供商](/concepts/model-providers)了解提供商级别的规则。
