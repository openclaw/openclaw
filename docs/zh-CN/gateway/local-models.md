---
read_when:
  - 你想在自己的 GPU 设备上部署模型
  - 你正在配置 LM Studio 或 OpenAI 兼容代理
  - 你需要最安全的本地模型指南
summary: 在本地 LLM 上运行 OpenClaw（LM Studio、vLLM、LiteLLM、自定义 OpenAI 端点）
title: 本地模型
x-i18n:
  generated_at: "2026-02-01T20:35:10Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f72b424c3d8986319868dc4c552596bcd599cc79fab5a57c14bf4f0695c39690
  source_path: gateway/local-models.md
  workflow: 14
---

# 本地模型

本地部署是可行的，但 OpenClaw 需要大上下文窗口以及强大的提示注入防护能力。小显存会截断上下文并导致安全性降低。建议高配：**≥2 台满配 Mac Studio 或同等级别的 GPU 设备（约 $30k+）**。单块 **24 GB** 显卡仅适用于较轻量的提示，且延迟较高。请使用**你能运行的最大/完整版模型**；激进量化或"小型"检查点会增加提示注入风险（参见[安全](/gateway/security)）。

## 推荐方案：LM Studio + MiniMax M2.1（Responses API，完整版）

目前最佳的本地技术栈。在 LM Studio 中加载 MiniMax M2.1，启用本地服务器（默认 `http://127.0.0.1:1234`），并使用 Responses API 将推理过程与最终文本分离。

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-5": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
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
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
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

**配置清单**

- 安装 LM Studio：https://lmstudio.ai
- 在 LM Studio 中下载**可用的最大 MiniMax M2.1 版本**（避免"小型"/重度量化版本），启动服务器，确认 `http://127.0.0.1:1234/v1/models` 中已列出该模型。
- 保持模型处于已加载状态；冷加载会增加启动延迟。
- 如果你的 LM Studio 版本不同，请调整 `contextWindow`/`maxTokens`。
- 对于 WhatsApp，请使用 Responses API 以确保只发送最终文本。

即使运行本地模型，也请保留托管模型的配置；使用 `models.mode: "merge"` 以保持备用方案可用。

### 混合配置：托管为主，本地备用

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-5"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-5": { alias: "Opus" },
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
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
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

### 本地优先，托管兜底

将主模型和备用模型的顺序对调；保持相同的 providers 配置块和 `models.mode: "merge"`，这样当本地设备宕机时可以回退到 Sonnet 或 Opus。

### 区域托管/数据路由

- MiniMax/Kimi/GLM 的托管版本也可在 OpenRouter 上使用，并提供区域锁定端点（例如美国托管）。选择对应的区域版本以将流量保持在你选择的管辖区域内，同时仍可通过 `models.mode: "merge"` 使用 Anthropic/OpenAI 备用方案。
- 纯本地部署仍然是最强的隐私保护方案；托管区域路由是需要提供商功能但又想控制数据流向时的折中选择。

## 其他 OpenAI 兼容的本地代理

vLLM、LiteLLM、OAI-proxy 或自定义网关均可使用，前提是它们暴露了 OpenAI 风格的 `/v1` 端点。将上面的提供商配置块替换为你的端点和模型 ID：

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

保持 `models.mode: "merge"` 以确保托管模型作为备用方案仍然可用。

## 故障排除

- Gateway网关能否访问代理？执行 `curl http://127.0.0.1:1234/v1/models` 检查。
- LM Studio 模型已卸载？重新加载；冷启动是常见的"卡住"原因。
- 上下文错误？降低 `contextWindow` 或提高服务器限制。
- 安全性：本地模型跳过了提供商侧的过滤；请保持智能体范围精简并开启压缩，以限制提示注入的影响范围。
