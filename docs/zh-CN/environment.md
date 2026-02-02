---
read_when:
  - 需要了解加载了哪些环境变量及其加载顺序
  - 正在调试 Gateway网关中缺失的 API 密钥
  - 正在编写提供商认证或部署环境的文档
summary: OpenClaw 从哪里加载环境变量及其优先级顺序
title: 环境变量
x-i18n:
  generated_at: "2026-02-01T20:24:58Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b49ae50e5d306612f89f93a86236188a4f2ec23f667e2388b043832be3ac1546
  source_path: environment.md
  workflow: 14
---

# 环境变量

OpenClaw 从多个来源获取环境变量。规则是**永远不覆盖已有的值**。

## 优先级（从高到低）

1. **进程环境**（Gateway网关进程从父 shell/守护进程继承的变量）。
2. **当前工作目录下的 `.env`**（dotenv 默认行为；不覆盖已有值）。
3. **全局 `.env`**，位于 `~/.openclaw/.env`（即 `$OPENCLAW_STATE_DIR/.env`；不覆盖已有值）。
4. **配置文件中的 `env` 块**，位于 `~/.openclaw/openclaw.json`（仅在变量缺失时应用）。
5. **可选的登录 shell 导入**（`env.shellEnv.enabled` 或 `OPENCLAW_LOAD_SHELL_ENV=1`），仅对缺失的预期键生效。

如果配置文件完全不存在，则跳过步骤 4；如果已启用，shell 导入仍会运行。

## 配置文件 `env` 块

有两种等效方式设置内联环境变量（两者都不覆盖已有值）：

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Shell 环境导入

`env.shellEnv` 会运行你的登录 shell，并仅导入**缺失的**预期键：

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

等效的环境变量：

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## 配置中的环境变量替换

你可以使用 `${VAR_NAME}` 语法在配置字符串值中直接引用环境变量：

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

详情请参阅[配置：环境变量替换](/gateway/configuration#env-var-substitution-in-config)。

## 相关内容

- [Gateway网关配置](/gateway/configuration)
- [常见问题：环境变量与 .env 加载](/help/faq#env-vars-and-env-loading)
- [模型概览](/concepts/models)
