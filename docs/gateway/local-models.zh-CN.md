---
summary: "在本地 LLM 上运行 OpenClaw（LM Studio、vLLM、LiteLLM、自定义 OpenAI 端点）"
read_when:
  - 您想从自己的 GPU 盒子提供模型
  - 您正在连接 LM Studio 或兼容 OpenAI 的代理
  - 您需要最安全的本地模型指导
title: "本地模型"
---

# 本地模型

本地运行是可行的，但 OpenClaw 期望大上下文 + 强大的防御措施来防止提示注入。小卡片会截断上下文并泄露安全性。目标要高：**≥2 台最大化的 Mac Studio 或等效的 GPU 设备（约 $30k+）**。单个 **24 GB** GPU 仅适用于具有更高延迟的较轻提示。使用**您可以运行的最大/全尺寸模型变体**；过度量化或“小”检查点会增加提示注入风险（请参阅[安全性](/gateway/security)）。

如果您想要最低摩擦的本地设置，请从 [LM Studio](/providers/lmstudio) 或 [Ollama](/providers/ollama) 和 `openclaw onboard` 开始。本页是针对高端本地堆栈和自定义 OpenAI 兼容本地服务器的指导性指南。

## 推荐：LM Studio + 大型本地模型（Responses API）

当前最佳本地堆栈。在 LM Studio 中加载大型模型（例如，全尺寸的 Qwen、DeepSeek 或 Llama 构建），启用本地服务器（默认 `http://127.0.0.1:1234`），并使用 Responses API 保持推理与最终文本分离。

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/my-local-model" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/my-local-model": { alias: "Local" },
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
            id: "my-local-model",
            name: "Local Model",
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
- 在 LM Studio 中，下载**可用的最大模型构建**（避免“小”/过度量化的变体），启动服务器，确认 `http://127.0.0.1:1234/v1/models` 列出了它。
- 用 LM Studio 中显示的实际模型 ID 替换 `my-local-model`。
- 保持模型加载；冷加载会增加启动延迟。
- 如果您的 LM Studio 构建不同，调整 `contextWindow`/`maxTokens`。
- 对于 WhatsApp，坚持使用 Responses API，以便只发送最终文本。

即使在运行本地模型时，也要配置托管模型；使用 `models.mode: "merge"` 以便回退保持可用。

### 混合配置：托管主模型，本地回退

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["lmstudio/my-local-model", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
        "lmstudio/my-local-model": { alias: "Local" },
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
            id: "my-local-model",
            name: "Local Model",
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

### 本地优先，托管安全网

交换主模型和回退顺序；保持相同的提供商块和 `models.mode: "merge"`，以便当本地设备关闭时，您可以回退到 Sonnet 或 Opus。

### 区域托管 / 数据路由

- 托管的 MiniMax/Kimi/GLM 变体也存在于 OpenRouter 上，带有区域固定端点（例如，美国托管）。在那里选择区域变体，以保持流量在您选择的司法管辖区内，同时仍然使用 `models.mode: "merge"` 作为 Anthropic/OpenAI 回退。
- 仅限本地仍然是最强的隐私路径；当您需要提供商功能但想要控制数据流时，托管区域路由是中间地带。

## 其他兼容 OpenAI 的本地代理

vLLM、LiteLLM、OAI-proxy 或自定义网关如果暴露 OpenAI 风格的 `/v1` 端点，就可以工作。用您的端点和模型 ID 替换上面的提供商块：

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

保持 `models.mode: "merge"`，以便托管模型作为回退保持可用。

本地/代理 `/v1` 后端的行为说明：

- OpenClaw 将这些视为代理风格的 OpenAI 兼容路由，而不是原生
  OpenAI 端点
- 仅原生 OpenAI 的请求塑造不适用于这里：没有
  `service_tier`，没有 Responses `store`，没有 OpenAI 推理兼容有效负载
  塑造，也没有提示缓存提示
- 隐藏的 OpenClaw 归因标头（`originator`、`version`、`User-Agent`）
  不会在这些自定义代理 URL 上注入

更严格的 OpenAI 兼容后端的兼容性说明：

- 某些服务器在 Chat Completions 上只接受字符串 `messages[].content`，而不是
  结构化内容部分数组。为
  这些端点设置
  `models.providers.<provider>.models[].compat.requiresStringContent: true`。
- 一些较小或更严格的本地后端对 OpenClaw 的完整
  代理运行时提示形状不稳定，尤其是当包含工具架构时。如果后端
  对微小的直接 `/v1/chat/completions` 调用有效，但在正常
  OpenClaw 代理回合上失败，首先尝试
  `agents.defaults.experimental.localModelLean: true` 以删除重量级
  默认工具如 `browser`、`cron` 和 `message`；这是一个实验性
  标志，不是稳定的默认模式设置。请参阅
  [实验性功能](/concepts/experimental-features)。如果仍然失败，尝试
  `models.providers.<provider>.models[].compat.supportsTools: false`。
- 如果后端仍然只在较大的 OpenClaw 运行时失败，剩余的问题
  通常是上游模型/服务器容量或后端错误，而不是 OpenClaw 的
  传输层。

## 故障排除

- 网关可以到达代理吗？`curl http://127.0.0.1:1234/v1/models`。
- LM Studio 模型未加载？重新加载；冷启动是常见的“挂起”原因。
- 当检测到的上下文窗口低于 **32k** 时，OpenClaw 会发出警告，低于 **16k** 时会阻止。如果您遇到该预检，请提高服务器/模型上下文限制或选择更大的模型。
- 上下文错误？降低 `contextWindow` 或提高服务器限制。
- 兼容 OpenAI 的服务器返回 `messages[].content ... expected a string`？
  在该模型条目上添加 `compat.requiresStringContent: true`。
- 直接的微小 `/v1/chat/completions` 调用有效，但 `openclaw infer model run`
  在 Gemma 或其他本地模型上失败？首先使用
  `compat.supportsTools: false` 禁用工具架构，然后重新测试。如果服务器仍然只在较大的 OpenClaw 提示时崩溃，将其视为上游服务器/模型限制。
- 安全性：本地模型跳过提供商侧过滤器；保持代理范围狭窄并开启压缩以限制提示注入的影响范围。