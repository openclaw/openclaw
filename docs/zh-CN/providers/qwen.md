---
read_when:
  - 你想在 OpenClaw 中使用 Qwen
  - 你想要免费层 OAuth 或付费 DashScope API 访问
summary: 在 OpenClaw 中通过 OAuth（免费层）或 DashScope API 使用 Qwen
title: Qwen
x-i18n:
  generated_at: "2026-03-01T00:00:00Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: manual
  source_path: providers/qwen.md
  workflow: manual
---

# Qwen

OpenClaw 中 Qwen 提供两种认证方式：

- **方式 A：OAuth（免费层）** — 设备码流程，用于 Qwen Coder 和 Qwen Vision（每天 2,000 次请求）。
- **方式 B：DashScope API** — API 密钥，可访问完整 Qwen 模型目录（Qwen-Max、Qwen-Plus、Qwen-Turbo 等）。

---

## 方式 A：OAuth（免费层）

**适用于：** 无需 API 密钥即可免费使用 Qwen Coder 和 Qwen Vision。

### 启用插件

```bash
openclaw plugins enable qwen-portal-auth
```

启用后重启 Gateway 网关。

### 认证

```bash
openclaw models auth login --provider qwen-portal --set-default
```

这会运行 Qwen 设备码 OAuth 流程，并将提供商条目写入你的 `models.json`（以及一个 `qwen` 别名便于快速切换）。

### 模型 ID（OAuth）

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

切换模型：

```bash
openclaw models set qwen-portal/coder-model
```

### 复用 Qwen Code CLI 登录

如果你已使用 Qwen Code CLI 登录，OpenClaw 会在加载认证存储时从 `~/.qwen/oauth_creds.json` 同步凭证。你仍然需要一个 `models.providers.qwen-portal` 条目（使用上面的登录命令创建）。

---

## 方式 B：DashScope API（API 密钥）

**适用于：** 完整 Qwen 模型目录、更高速率限制和按量计费。

DashScope 是阿里云提供的 Qwen 模型 API 平台。它提供 OpenAI 兼容端点，因此 OpenClaw 可通过自定义提供商使用。

### 前置条件

1. 阿里云账户
2. 已激活 Model Studio（DashScope）— [Model Studio 控制台](https://bailian.console.alibabacloud.com/#/home)
3. 从 [API-KEY 页面](https://bailian.console.alibabacloud.com/?apiKey=1#/api-key) 获取 API 密钥

### 区域选择

根据你的区域选择 base URL：

| 区域             | Base URL                                                 |
| ---------------- | -------------------------------------------------------- |
| 中国（北京）     | `https://dashscope.aliyuncs.com/compatible-mode/v1`      |
| 国际（新加坡）   | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| 美国（弗吉尼亚） | `https://dashscope-us.aliyuncs.com/compatible-mode/v1`   |

### CLI 设置（环境变量）

```bash
export DASHSCOPE_API_KEY="sk-..."
openclaw onboard
# 或添加到 ~/.openclaw/.env 供守护进程使用
```

### 配置片段（DashScope API）

```json5
{
  env: { DASHSCOPE_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "dashscope/qwen-max" },
      models: {
        "dashscope/qwen-max": { alias: "Qwen Max" },
        "dashscope/qwen-plus": { alias: "Qwen Plus" },
        "dashscope/qwen-turbo": { alias: "Qwen Turbo" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      dashscope: {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "${DASHSCOPE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "qwen-max",
            name: "Qwen Max",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "qwen-plus",
            name: "Qwen Plus",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "qwen-turbo",
            name: "Qwen Turbo",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "qwen3-max",
            name: "Qwen3 Max",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "qwen3.5-plus",
            name: "Qwen3.5 Plus",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

> **注意：** 上述模型字段（`contextWindow`、`maxTokens`、`cost` 等）仅为示例值，可能不准确。请以[阿里云 Model Studio 官方文档](https://www.alibabacloud.com/help/en/model-studio/models)为准。本配置仅作为向 `openclaw.json` 添加模型的示例模板。

国际（新加坡）区域使用：

```json5
baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
```

美国（弗吉尼亚）区域使用：

```json5
baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1"
```

### 模型 ID（DashScope）

常用模型 ID（最新列表请查阅 [阿里云 Model Studio](https://www.alibabacloud.com/help/en/model-studio/models)）：

- `qwen-max`、`qwen-max-latest`
- `qwen-plus`、`qwen-plus-latest`
- `qwen-turbo`、`qwen-turbo-latest`
- `qwen3-max`、`qwen3-max-preview`
- `qwen3.5-plus`、`qwen3.5-flash`
- `qwen3-coder-plus`（编程）
- `qwen3-8b`、`qwen3-14b`、`qwen3-32b`（开源）

模型引用格式为 `dashscope/<modelId>`（例如 `dashscope/qwen-max`）。

### 非交互式示例

```bash
export DASHSCOPE_API_KEY="sk-..."
# 通过配置添加提供商，然后：
openclaw models set dashscope/qwen-max
```

---

## 注意事项

- **OAuth：** 令牌自动刷新；如果刷新失败或访问被撤销，请重新运行登录命令。
- **OAuth：** 默认 base URL：`https://portal.qwen.ai/v1`（如果 Qwen 提供不同端点，可使用 `models.providers.qwen-portal.baseUrl` 覆盖）。
- **DashScope：** API 密钥通常以 `sk-` 开头；当 Gateway 网关作为守护进程运行时，请存储在 `~/.openclaw/.env` 中。
- 参阅[模型提供商](/zh-CN/concepts/model-providers)了解提供商级别的规则。
