---
read_when:
  - 你想让 OpenClaw 连接本地 SGLang 服务器运行
  - 你想通过自己的模型使用兼容 OpenAI 的 `/v1` 端点
summary: 让 OpenClaw 与 SGLang 一起运行（兼容 OpenAI 的自托管服务器）
title: SGLang
x-i18n:
  generated_at: "2026-03-16T06:27:01Z"
  model: gpt-5.4
  provider: openai
  source_hash: 26ba858c46bc2b82088274c62270500ffc243e5fb505b8aaaffc096d835187b0
  source_path: providers/sglang.md
  workflow: 15
---

# SGLang

SGLang 可以通过**兼容 OpenAI** 的 HTTP API 提供开源模型服务。
OpenClaw 可以使用 `openai-completions` API 连接到 SGLang。

当你通过 `SGLANG_API_KEY` 选择加入时，OpenClaw 还可以**自动发现**
SGLang 提供的可用模型（如果你的服务器不强制身份验证，任意值都可）
并且你没有定义显式的 `models.providers.sglang` 条目。

## 快速开始

1. 使用兼容 OpenAI 的服务器启动 SGLang。

你的基础 URL 应暴露 `/v1` 端点（例如 `/v1/models`、
`/v1/chat/completions`）。SGLang 通常运行在：

- `http://127.0.0.1:30000/v1`

2. 选择加入（如果未配置身份验证，任意值都可）：

```bash
export SGLANG_API_KEY="sglang-local"
```

3. 运行新手引导并选择 `SGLang`，或直接设置模型：

```bash
openclaw onboard
```

```json5
{
  agents: {
    defaults: {
      model: { primary: "sglang/your-model-id" },
    },
  },
}
```

## 模型发现（隐式提供商）

当设置了 `SGLANG_API_KEY`（或存在 auth profile），并且你**没有**
定义 `models.providers.sglang` 时，OpenClaw 将查询：

- `GET http://127.0.0.1:30000/v1/models`

并将返回的 ID 转换为模型条目。

如果你显式设置了 `models.providers.sglang`，则会跳过自动发现，
你必须手动定义模型。

## 显式配置（手动模型）

在以下情况下使用显式配置：

- SGLang 运行在不同的主机/端口上。
- 你想固定 `contextWindow`/`maxTokens` 值。
- 你的服务器需要真实 API 密钥（或者你想控制请求头）。

```json5
{
  models: {
    providers: {
      sglang: {
        baseUrl: "http://127.0.0.1:30000/v1",
        apiKey: "${SGLANG_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "本地 SGLang 模型",
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

## 故障排除

- 检查服务器是否可访问：

```bash
curl http://127.0.0.1:30000/v1/models
```

- 如果请求因身份验证错误而失败，请设置与
  你的服务器配置匹配的真实 `SGLANG_API_KEY`，或者在
  `models.providers.sglang` 下显式配置该提供商。
