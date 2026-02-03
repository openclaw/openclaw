---
read_when:
  - 你想在 OpenClaw 中使用 Qwen
  - 你想通过免费版 OAuth 访问 Qwen Coder
summary: 在 OpenClaw 中使用 Qwen OAuth（免费版）
title: Qwen
x-i18n:
  generated_at: "2026-02-01T21:35:24Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 88b88e224e2fecbb1ca26e24fbccdbe25609be40b38335d0451343a5da53fdd4
  source_path: providers/qwen.md
  workflow: 15
---

# Qwen

Qwen 提供免费版 OAuth 流程，可访问 Qwen Coder 和 Qwen Vision 模型（每天 2,000 次请求，受 Qwen 速率限制约束）。

## 启用插件

```bash
openclaw plugins enable qwen-portal-auth
```

启用后重启 Gateway网关。

## 认证

```bash
openclaw models auth login --provider qwen-portal --set-default
```

这将运行 Qwen 设备码 OAuth 流程，并将提供商条目写入你的 `models.json`（同时创建一个 `qwen` 别名以便快速切换）。

## 模型 ID

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

切换模型：

```bash
openclaw models set qwen-portal/coder-model
```

## 复用 Qwen Code CLI 登录

如果你已经通过 Qwen Code CLI 登录，OpenClaw 在加载认证存储时会从 `~/.qwen/oauth_creds.json` 同步凭据。你仍然需要一个 `models.providers.qwen-portal` 条目（使用上面的登录命令创建）。

## 注意事项

- 令牌会自动刷新；如果刷新失败或访问被撤销，请重新运行登录命令。
- 默认基础 URL：`https://portal.qwen.ai/v1`（如果 Qwen 提供了不同的端点，可通过 `models.providers.qwen-portal.baseUrl` 覆盖）。
- 有关提供商通用规则，请参阅[模型提供商](/concepts/model-providers)。
