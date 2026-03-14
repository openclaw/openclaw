---
read_when:
  - 你需要知道哪些环境变量被加载，以及加载顺序
  - 你在调试 Gateway 网关中缺失的 API 密钥
  - 你在编写提供商认证或部署环境的文档
summary: OpenClaw 从哪里加载环境变量以及优先级顺序
title: 环境变量
x-i18n:
  generated_at: "2026-02-03T07:47:11Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b49ae50e5d306612f89f93a86236188a4f2ec23f667e2388b043832be3ac1546
  source_path: help/environment.md
  workflow: 15
---

# 环境变量

OpenClaw 从多个来源拉取环境变量。规则是**永不覆盖现有值**。

## 优先级（从高到低）

1. **进程环境**（Gateway 网关进程从父 shell/守护进程已有的内容）。
2. **当前工作目录中的 `.env`**（dotenv 默认；不覆盖）。
3. **全局 `.env`** 位于 `~/.openclaw/.env`（即 `$OPENCLAW_STATE_DIR/.env`；不覆盖）。
4. **配置 `env` 块** 位于 `~/.openclaw/openclaw.json`（仅在缺失时应用）。
5. **可选的登录 shell 导入**（`env.shellEnv.enabled` 或 `OPENCLAW_LOAD_SHELL_ENV=1`），仅对缺失的预期键名应用。

如果配置文件完全缺失，步骤 4 将被跳过；如果启用了 shell 导入，它仍会运行。

## 配置 `env` 块

两种等效方式设置内联环境变量（都是非覆盖的）：

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

`env.shellEnv` 运行你的登录 shell 并仅导入**缺失的**预期键名：

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

环境变量等效项：

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

完整详情参见[配置：环境变量替换](/gateway/configuration#env-var-substitution-in-config)。

## 相关内容

- [Gateway 网关配置](/gateway/configuration)
- [常见问题：环境变量和 .env 加载](/help/faq#env-vars-and-env-loading)
- [模型概述](/concepts/models)
