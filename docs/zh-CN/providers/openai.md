---
read_when:
  - 你想在 OpenClaw 中使用 OpenAI 模型
  - 你想使用 Codex 订阅身份验证而不是 API 密钥
summary: 在 OpenClaw 中通过 API 密钥或 Codex 订阅使用 OpenAI
title: OpenAI
x-i18n:
  generated_at: "2026-03-16T06:26:45Z"
  model: gpt-5.4
  provider: openai
  source_hash: a348d8fca7b809f84c6b90bf6a799e0a070a6e7b98a78b2cd2d747bb3d2b2212
  source_path: providers/openai.md
  workflow: 15
---

# OpenAI

OpenAI 为 GPT 模型提供开发者 API。Codex 支持**ChatGPT 登录**以进行订阅
访问，也支持**API 密钥**登录以进行按使用量计费的访问。Codex cloud 需要 ChatGPT 登录。
OpenAI 明确支持在 OpenClaw 这样的外部工具/工作流中使用订阅 OAuth。

## 选项 A：OpenAI API 密钥（OpenAI Platform）

**最适合：** 直接 API 访问和按使用量计费。
从 OpenAI 控制台获取你的 API 密钥。

### CLI 设置

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 配置片段

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

OpenAI 当前的 API 模型文档将 `gpt-5.4` 和 `gpt-5.4-pro` 列为直接
OpenAI API 用法的模型。OpenClaw 会通过 `openai/*` Responses 路径转发这两者。
OpenClaw 会有意隐藏过时的 `openai/gpt-5.3-codex-spark` 条目，
因为直接 OpenAI API 调用会在实际流量中拒绝它。

OpenClaw **不会**在直接 OpenAI
API 路径上暴露 `openai/gpt-5.3-codex-spark`。`pi-ai` 仍然为该模型提供内置条目，但当前实际 OpenAI API
请求会拒绝它。在 OpenClaw 中，Spark 被视为仅限 Codex。

## 选项 B：OpenAI Code（Codex）订阅

**最适合：** 使用 ChatGPT/Codex 订阅访问，而不是 API 密钥。
Codex cloud 需要 ChatGPT 登录，而 Codex CLI 支持 ChatGPT 或 API 密钥登录。

### CLI 设置（Codex OAuth）

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### 配置片段（Codex 订阅）

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

OpenAI 当前的 Codex 文档将 `gpt-5.4` 列为当前 Codex 模型。OpenClaw
会将其映射为 `openai-codex/gpt-5.4`，用于 ChatGPT/Codex OAuth。

如果你的 Codex 账户有权使用 Codex Spark，OpenClaw 也支持：

- `openai-codex/gpt-5.3-codex-spark`

OpenClaw 将 Codex Spark 视为仅限 Codex。它不会暴露直接的
`openai/gpt-5.3-codex-spark` API 密钥路径。

当 `pi-ai`
发现 `openai-codex/gpt-5.3-codex-spark` 时，OpenClaw 也会保留它。请将其视为依赖 entitlement 且处于实验阶段：Codex Spark 与 GPT-5.4 `/fast` 分开，是否可用取决于已登录的 Codex /
ChatGPT 账户。

### 默认传输

OpenClaw 使用 `pi-ai` 进行模型流式传输。对于 `openai/*` 和
`openai-codex/*`，默认传输都是 `"auto"`（优先 WebSocket，然后回退到 SSE）。

你可以设置 `agents.defaults.models.<provider/model>.params.transport`：

- `"sse"`：强制使用 SSE
- `"websocket"`：强制使用 WebSocket
- `"auto"`：尝试 WebSocket，然后回退到 SSE

对于 `openai/*`（Responses API），当使用 WebSocket 传输时，
OpenClaw 还会默认启用 WebSocket 预热
（`openaiWsWarmup: true`）。

相关 OpenAI 文档：

- [Realtime API with WebSocket](https://platform.openai.com/docs/guides/realtime-websocket)
- [Streaming API responses (SSE)](https://platform.openai.com/docs/guides/streaming-responses)

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai-codex/gpt-5.4" },
      models: {
        "openai-codex/gpt-5.4": {
          params: {
            transport: "auto",
          },
        },
      },
    },
  },
}
```

### OpenAI WebSocket 预热

OpenAI 文档将预热描述为可选。OpenClaw 对
`openai/*` 默认启用它，以在使用 WebSocket 传输时减少首次响应延迟。

### 禁用预热

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            openaiWsWarmup: false,
          },
        },
      },
    },
  },
}
```

### 显式启用预热

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            openaiWsWarmup: true,
          },
        },
      },
    },
  },
}
```

### OpenAI 优先处理

OpenAI 的 API 通过 `service_tier=priority` 暴露优先处理。在
OpenClaw 中，设置 `agents.defaults.models["openai/<model>"].params.serviceTier`，即可
在直接 `openai/*` Responses 请求中透传该字段。

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            serviceTier: "priority",
          },
        },
      },
    },
  },
}
```

支持的值为 `auto`、`default`、`flex` 和 `priority`。

### OpenAI 快速模式

OpenClaw 为 `openai/*` 和
`openai-codex/*` 会话公开了共享快速模式开关：

- 聊天/UI：`/fast status|on|off`
- 配置：`agents.defaults.models["<provider>/<model>"].params.fastMode`

启用快速模式后，OpenClaw 会应用低延迟 OpenAI 配置：

- 当负载未明确指定 reasoning 时，设置 `reasoning.effort = "low"`
- 当负载未明确指定 verbosity 时，设置 `text.verbosity = "low"`
- 对直接发往 `api.openai.com` 的 `openai/*` Responses 调用设置 `service_tier = "priority"`

示例：

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            fastMode: true,
          },
        },
        "openai-codex/gpt-5.4": {
          params: {
            fastMode: true,
          },
        },
      },
    },
  },
}
```

会话覆盖优先于配置。在会话 UI 中清除会话覆盖后，
该会话会恢复为配置的默认值。

### OpenAI Responses 服务端压缩

对于直接 OpenAI Responses 模型（使用 `api: "openai-responses"` 的 `openai/*`，
且 `baseUrl` 指向 `api.openai.com`），OpenClaw 现在会自动启用 OpenAI 服务端
压缩负载提示：

- 强制设置 `store: true`（除非模型兼容性设置 `supportsStore: false`）
- 注入 `context_management: [{ type: "compaction", compact_threshold: ... }]`

默认情况下，`compact_threshold` 为模型 `contextWindow` 的 `70%`（或在不可用时为 `80000`）。

### 显式启用服务端压缩

当你想在兼容的
Responses 模型上强制注入 `context_management` 时使用此设置（例如 Azure OpenAI Responses）：

```json5
{
  agents: {
    defaults: {
      models: {
        "azure-openai-responses/gpt-5.4": {
          params: {
            responsesServerCompaction: true,
          },
        },
      },
    },
  },
}
```

### 使用自定义阈值启用

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            responsesServerCompaction: true,
            responsesCompactThreshold: 120000,
          },
        },
      },
    },
  },
}
```

### 禁用服务端压缩

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            responsesServerCompaction: false,
          },
        },
      },
    },
  },
}
```

`responsesServerCompaction` 仅控制 `context_management` 注入。
直接 OpenAI Responses 模型仍会强制设置 `store: true`，除非兼容性设置
了 `supportsStore: false`。

## 说明

- 模型引用始终使用 `provider/model`（参见 [/concepts/models](/concepts/models)）。
- 身份验证详情和复用规则见 [/concepts/oauth](/concepts/oauth)。
