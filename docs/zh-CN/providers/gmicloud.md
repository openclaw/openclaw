---
summary: "GMI Cloud 配置（鉴权 + 模型选择）"
read_when:
  - 你想在 OpenClaw 中使用 GMI Cloud
  - 你需要 API Key 环境变量或 CLI 鉴权选项
---

# GMI Cloud

[GMI Cloud](https://www.gmicloud.ai/) 提供 GPU 云推理服务，通过 OpenAI 兼容接口接入 DeepSeek、Qwen、Llama、Kimi 等模型。

- Provider: `gmicloud`
- 鉴权变量: `GMI_CLOUD_API_KEY`
- API: OpenAI 兼容（`https://api.gmi-serving.com/v1`）

## 快速开始

1. 设置 API Key：

```bash
openclaw onboard --auth-choice gmicloud-api-key
```

2. 设置默认模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "gmicloud/deepseek-ai/DeepSeek-V3-0324" },
    },
  },
}
```

## 非交互示例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice gmicloud-api-key \
  --gmicloud-api-key "$GMI_CLOUD_API_KEY"
```

## 可用模型

已与当前 Dify GMI Cloud 插件中的模型集同步，包含：

- **Anthropic**: `anthropic/claude-opus-4.6`, `anthropic/claude-sonnet-4.6`
- **GPT**: `openai/gpt-5.4`, `openai/gpt-5.4-pro`, `openai/gpt-5.4-mini`, `openai/gpt-5.4-nano`, `openai/gpt-oss-120b`
- **Google Gemini**: `google/gemini-3.1-pro-preview`, `google/gemini-3.1-flash-lite-preview`
- **GLM**: `zai-org/GLM-5-FP8`, `zai-org/GLM-4.6`
- **DeepSeek**: `deepseek-ai/DeepSeek-V3-0324`, `deepseek-ai/DeepSeek-V3.1`, `deepseek-ai/DeepSeek-V3.2`
- **Kimi**: `moonshotai/Kimi-K2.5`, `moonshotai/Kimi-K2-Thinking`, `moonshotai/Kimi-K2-Instruct-0905`
- **Qwen**: `Qwen/Qwen3-32B-FP8`, `Qwen/Qwen3-Next-80B-A3B-Instruct`, `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8`, `Qwen/Qwen3-235B-A22B-Thinking-2507-FP8`
- **Llama**: `meta-llama/Llama-4-Scout-17B-16E-Instruct`
