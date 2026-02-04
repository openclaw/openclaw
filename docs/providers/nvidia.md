---
summary: "Use NVIDIA NIM API for Kimi K2.5, DeepSeek V3.2, MiniMax M2.1, GLM-4.7 and more"
read_when:
  - You want to use NVIDIA NIM LLM models in OpenClaw
  - You need Kimi K2.5, DeepSeek, Qwen, LLaMA, or other models via NVIDIA
title: "NVIDIA NIM"
---

# NVIDIA NIM

NVIDIA NIM provides access to a wide range of state-of-the-art LLM models through an OpenAI-compatible API. Configure the provider and set your default model to `nvidia/moonshotai/kimi-k2.5`, `nvidia/deepseek-ai/deepseek-v3.2`, or any other available model.

## Getting started

1. Get your NVIDIA API key from [build.nvidia.com](https://build.nvidia.com/)
2. Set the `NVIDIA_API_KEY` environment variable
3. Configure the provider in your OpenClaw config

```bash
openclaw onboard --auth-choice nvidia-api-key
```

## Available models (alphabetical list)

### A

- `nvidia/` - See full list below

### B

### C

### D

- `nvidia/deepseek-ai/deepseek-r1` - DeepSeek R1 reasoning model
- `nvidia/deepseek-ai/deepseek-v3.2` - DeepSeek V3.2 with reasoning and tool call support

### G

- `nvidia/google/gemma-2-27b-it` - Gemma 2 27B Instruct
- `nvidia/google/gemma-2-9b-it` - Gemma 2 9B Instruct
- `nvidia/google/gemma-3-27b-it` - Gemma 3 27B Instruct
- `nvidia/google/hlx-gemma-2-27b-it` - HLX Gemma 2 27B Instruct
- `nvidia/google/hlx-gemma-3-27b-it` - HLX Gemma 3 27B Instruct
- `nvidia/glm-4-7` - GLM-4.7 (Z.AI)
- `nvidia/glm-4-7-longchat` - GLM-4.7 Long Chat
- `nvidia/glm-4-7-searchable` - GLM-4.7 Searchable
- `nvidia/glm-4-7-unicode` - GLM-4.7 Unicode
- `nvidia/glm-4v7` - GLM-4V7 (Vision)
- `nvidia/glm-z1-1b-a3b-instruct` - GLM Z1 1B A3B Instruct
- `nvidia/glm-z1-a3b-instruct` - GLM Z1 A3B Instruct
- `nvidia/groq/llama-3-groq-1b-it` - Llama 3 Groq 1B Instruct
- `nvidia/groq/llama-3-groq-8b-it` - Llama 3 Groq 8B Instruct

### H

- `nvidia/hugging-faceh4-zephyr-7b-beta` - Hugging FaceH4 Zephyr 7B Beta

### I

- `nvidia/ibm-granite-34b-code-instruct` - IBM Granite 34B Code Instruct
- `nvidia/ibm-granite-8b-code-instruct` - IBM Granite 8B Code Instruct

### K

- `nvidia/mistralai/mistral-7b-instruct-v0.3` - Mistral 7B Instruct v0.3
- `nvidia/mistralai/mistral-large` - Mistral Large
- `nvidia/mistralai/mixtral-8x7b-instruct-v0.1` - Mixtral 8x7B Instruct v0.1
- `nvidia/mistralai/mixtral-8x22b-instruct-v0.1` - Mixtral 8x22B Instruct v0.1
- `nvidia/mistralai/mixtral-8x7b-instruct` - Mixtral 8x7B Instruct
- `nvidia/minimaxai/minimax-m2.1` - MiniMax M2.1 with advanced reasoning capabilities
- `nvidia/meta/llama-3.1-405b-instruct` - Llama 3.1 405B Instruct
- `nvidia/meta/llama-3.1-8b-instruct` - Llama 3.1 8B Instruct
- `nvidia/meta/llama-3.2-nemotron-51b-instruct` - Llama 3.2 Nemotron 51B Instruct
- `nvidia/meta/llama-3.3-70b-instruct` - Llama 3.3 70B Instruct
- `nvidia/meta/llama-3-groq-1b-instruct` - Llama 3 Groq 1B Instruct
- `nvidia/meta/llama-3-groq-8b-instruct` - Llama 3 Groq 8B Instruct
- `nvidia/moonshotai/kimi-k2.5` - Kimi K2.5 (multimodal, 1T parameters, 32B active)
- `nvidia/moonshotai/kimi-k2-0905-preview` - Kimi K2 0905 Preview
- `nvidia/moonshotai/kimi-k2-instruct-0905` - Kimi K2 Instruct 0905
- `nvidia/moonshotai/kimi-k2-thinking` - Kimi K2 Thinking
- `nvidia/mosaicml/mpt-30b-instruct` - MPT 30B Instruct
- `nvidia/mosaicml/mpt-7b-instruct` - MPT 7B Instruct

### N

- `nvidia/nemotron-3-45b-nemotron-instruct` - Nemotron 3 45B Nemotron Instruct
- `nvidia/nvidia/nemotron-3-nano-30b-a3b-instruct` - Nemotron 3 Nano 30B A3B Instruct
- `nvidia/nvidia/nemotron-4-340b-instruct` - Nemotron 4 340B Instruct
- `nvidia/nvidia/nemotron-4-340b-nemotron-instruct` - Nemotron 4 340B Nemotron Instruct
- `nvidia/nvidia/nemotron-5-015b-preview` - Nemotron 5 015B Preview
- `nvidia/nvidia/nemotron-5-1-15b-preview` - Nemotron 5.1 15B Preview
- `nvidia/nvidia/nemotron-5-dynamic-1-15b-preview` - Nemotron 5 Dynamic 1 15B Preview
- `nvidia/nvidia/nemotron-5-dynamic-1b-preview` - Nemotron 5 Dynamic 1B Preview
- `nvidia/nvidia/nemotron-cc-8b-instruct` - Nemotron CC 8B Instruct
- `nvidia/nvidia/nemotron-cc-mini-4b-instruct` - Nemotron CC Mini 4B Instruct
- `nvidia/nvidia/nemotron-lite-1b-nemotron-instruct` - Nemotron Lite 1B Nemotron Instruct
- `nvidia/nvidia/nemotron-nano-12b-v2-vl` - Nemotron Nano 12B v2 VL (Vision)
- `nvidia/nvidia/nemotron-nano-4b-nemotron-instruct` - Nemotron Nano 4B Nemotron Instruct
- `nvidia/nvidia/nemotron-nano-8b-nemotron-instruct` - Nemotron Nano 8B Nemotron Instruct
- `nvidia/nvidia/nemotron-nano-8b-nvn-instruct` - Nemotron Nano 8B NVN Instruct
- `nvidia/nvidia/nemotron-nano-te-15b-nemotron-instruct` - Nemotron Nano TE 15B Nemotron Instruct
- `nvidia/nvidia/nvidia-ace-43b-nemotron-instruct` - NVIDIA ACE 43B Nemotron Instruct
- `nvidia/nvidia/nvidia-ace-57b-nemotron-instruct` - NVIDIA ACE 57B Nemotron Instruct
- `nvidia/nvidia/nvidia-merge-1b-nemotron-instruct` - NVIDIA Merge 1B Nemotron Instruct
- `nvidia/nvidia/nvidia-merge-8b-nemotron-instruct` - NVIDIA Merge 8B Nemotron Instruct
- `nvidia/nvidia/nvidia-merge-te-8b-nemotron-instruct` - NVIDIA Merge TE 8B Nemotron Instruct
- `nvidia/nv-mqa/mq-15b-qwen-instruct` - NV MQA MQ 15B Qwen Instruct
- `nvidia/nv-mqa/mq-15b-qwen-nvn-instruct` - NV MQA MQ 15B Qwen NVN Instruct

### Q

- `nvidia/qwen/qwen-2-72b-instruct` - Qwen 2 72B Instruct
- `nvidia/qwen/qwen-2-vl-72b-instruct` - Qwen 2 VL 72B Instruct (Vision)
- `nvidia/qwen/qwen-2-vl-7b-instruct` - Qwen 2 VL 7B Instruct (Vision)
- `nvidia/qwen/qwen-2.5-72b-instruct` - Qwen 2.5 72B Instruct
- `nvidia/qwen/qwen-2.5-coder-32b-instruct` - Qwen 2.5 Coder 32B Instruct
- `nvidia/qwen/qwen-2.5-7b-instruct` - Qwen 2.5 7B Instruct
- `nvidia/qwen/qwen3-next-80b-a3b-instruct` - Qwen3 Next 80B A3B Instruct
- `nvidia/qwen/qwen3-next-80b-a3b-thinking` - Qwen3 Next 80B A3B Thinking
- `nvidia/qwen/qwen3-next-7b-a3b-instruct` - Qwen3 Next 7B A3B Instruct

### S

- `nvidia/snowflake/arctic` - Snowflake Arctic
- `nvidia/stack-llama-2-ty-550b-qwen-instruct` - Stack Llama 2 TY 550B Qwen Instruct
- `nvidia/stack-llama-2-ty-650b-qwen-instruct` - Stack Llama 2 TY 650B Qwen Instruct

### X

### Y

### Z

## Config snippet

```json5
{
  env: { NVIDIA_API_KEY: "nvapi-..." },
  agents: {
    defaults: {
      model: { primary: "nvidia/moonshotai/kimi-k2.5" },
      models: {
        // Popular models aliases
        "nvidia/moonshotai/kimi-k2.5": { alias: "Kimi K2.5" },
        "nvidia/deepseek-ai/deepseek-v3.2": { alias: "DeepSeek V3.2" },
        "nvidia/meta/llama-3.3-70b-instruct": { alias: "Llama 3.3 70B" },
        "nvidia/glm-4-7": { alias: "GLM-4.7" },
        "nvidia/minimaxai/minimax-m2.1": { alias: "MiniMax M2.1" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "${NVIDIA_API_KEY}",
        api: "openai-completions",
        models: [
          // Kimi K2.5 - Multimodal MoE (1T params, 32B active)
          {
            id: "moonshotai/kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: true,
            input: ["text", "image", "video"],
            cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          // DeepSeek V3.2
          {
            id: "deepseek-ai/deepseek-v3.2",
            name: "DeepSeek V3.2",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.28, output: 0.4, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 163840,
            maxTokens: 65536,
          },
          // MiniMax M2.1
          {
            id: "minimaxai/minimax-m2.1",
            name: "MiniMax M2.1",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 204800,
            maxTokens: 131072,
          },
          // GLM-4.7
          {
            id: "glm-4-7",
            name: "GLM-4.7",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
          // Llama 3.3 70B
          {
            id: "meta/llama-3.3-70b-instruct",
            name: "Llama 3.3 70B Instruct",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Notes

- NVIDIA model refs use `nvidia/<modelId>` format
- The NVIDIA NIM API is OpenAI-compatible (`openai-completions`)
- Some models support extended context windows up to 256K tokens
- Kimi K2.5 supports multimodal input (text, images, video)
- Reasoning models (DeepSeek V3.2, Kimi K2.5, MiniMax M2.1) have advanced thinking capabilities
- Pricing varies by model - check [build.nvidia.com](https://build.nvidia.com/) for current rates
- The base URL `https://integrate.api.nvidia.com/v1` provides unified access to all models

## Model families available

- **DeepSeek**: Advanced reasoning models (V3.2, R1)
- **Kimi (Moonshot)**: Multimodal MoE models (K2.5, K2 Thinking)
- **MiniMax**: High-performance reasoning (M2.1)
- **GLM**: Chinese-optimized models (GLM-4.7, GLM-4V7)
- **Llama**: Meta's open models (Llama 3.1, 3.2, 3.3)
- **Mistral**: Efficient inference (7B, Mixtral 8x7B, 8x22B)
- **Nemotron**: NVIDIA's optimized models (Nano, CC, ACE series)
- **Qwen**: Alibaba's models (Qwen 2.5, 3 Next)
- **Gemma**: Google's lightweight models (Gemma 2, 3)

See [build.nvidia.com/models](https://build.nvidia.com/models) for the complete catalog.
