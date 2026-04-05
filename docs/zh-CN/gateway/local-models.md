---
read_when:
  - 你想从自己的 GPU 主机提供模型服务
  - 你正在接入 LM Studio 或兼容 OpenAI 的代理
  - 你需要最安全的本地模型指南
summary: 在本地 LLM 上运行 OpenClaw（LM Studio、vLLM、LiteLLM、自定义 OpenAI 端点）
title: 本地模型
x-i18n:
  generated_at: "2026-03-16T06:22:54Z"
  model: gpt-5.4
  provider: openai
  source_hash: 43ad6b91216e12be4d0c9395c981e0b5d8bd16ba4952efd02b7261052304a4ce
  source_path: gateway/local-models.md
  workflow: 15
---

# 本地模型

本地部署是可行的，但 OpenClaw 需要大上下文和对提示注入的强防御能力。小显卡会截断上下文并削弱安全性。目标要高：**至少 2 台满配 Mac Studio 或同等 GPU 设备（约 3 万美元以上）**。单张 **24 GB** GPU 仅适用于较轻的提示，且延迟更高。请使用**你能运行的最大 / 完整尺寸模型变体**；激进量化或“small”检查点会提高提示注入风险（见 [安全](/gateway/security)）。

如果你想要摩擦最小的本地设置，请从 [Ollama](/providers/ollama) 和 `openclaw onboard` 开始。本页是面向更高端本地栈和自定义兼容 OpenAI 的本地服务器的偏好型指南。

## 推荐：LM Studio + MiniMax M2.5（Responses API，完整尺寸）

当前最佳的本地栈。先在 LM Studio 中加载 MiniMax M2.5，启用本地服务器（默认 `http://127.0.0.1:1234`），然后使用 Responses API 将推理与最终文本分离。

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.5-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.5-gs32": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.5-gs32",
            name: "MiniMax M2.5 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

**设置清单**

- 安装 LM Studio：[https://lmstudio.ai](https://lmstudio.ai)
- 在 LM Studio 中，下载**可用的最大 MiniMax M2.5 构建版本**（避免 “small” / 重度量化变体），启动服务器，并确认 `http://127.0.0.1:1234/v1/models` 中列出了它。
- 保持模型处于已加载状态；冷加载会增加启动延迟。
- 如果你的 LM Studio 构建不同，请调整 `contextWindow` / `maxTokens`。
- 对于 WhatsApp，请坚持使用 Responses API，这样只会发送最终文本。

即使在本地运行时，也要保留托管模型配置；使用 `models.mode: "merge"`，以便回退模型始终可用。

### 混合配置：托管主模型，本地回退

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["lmstudio/minimax-m2.5-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
        "lmstudio/minimax-m2.5-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.5-gs32",
            name: "MiniMax M2.5 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### 本地优先，并保留托管安全网

交换主模型与回退模型的顺序；保留相同的 providers 块和 `models.mode: "merge"`，这样当本地主机不可用时，你仍然可以回退到 Sonnet 或 Opus。

### 区域托管 / 数据路由

- OpenRouter 上也提供托管版 MiniMax / Kimi / GLM 变体，并带有区域固定端点（例如托管在美国）。可以在那里选择区域变体，将流量保留在你选定的司法辖区内，同时继续使用 `models.mode: "merge"` 作为 Anthropic / OpenAI 回退。
- 纯本地仍然是最强的隐私方案；当你需要提供商功能但又想控制数据流向时，托管区域路由是折中方案。

## 其他兼容 OpenAI 的本地代理

只要暴露兼容 OpenAI 风格的 `/v1` 端点，vLLM、LiteLLM、OAI-proxy 或自定义网关都可以工作。将上面的 provider 块替换为你的端点和模型 ID：

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

保留 `models.mode: "merge"`，这样托管模型仍可作为回退使用。

## 故障排除

- Gateway 网关能连接到代理吗？`curl http://127.0.0.1:1234/v1/models`
- LM Studio 模型已卸载？重新加载；冷启动是常见的“卡住”原因。
- 上下文错误？降低 `contextWindow` 或提高你的服务器限制。
- 安全性：本地模型会跳过提供商侧过滤；请保持智能体职责范围狭窄，并开启压缩，以限制提示注入的影响范围。
