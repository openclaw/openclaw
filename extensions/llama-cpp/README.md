# @openclaw/llama-cpp-provider

Official llama.cpp text-inference and embedding provider for OpenClaw.

This plugin runs local GGUF chat and embedding models in-process through
`node-llama-cpp`.

## Install

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

Restart the Gateway after installing or updating the plugin. Use Node 24 for
native installs and updates.

## Configure text inference

Choose **Local model (llama.cpp)** during onboarding. After explicit consent,
OpenClaw downloads the approximately 2.5 GB Qwen3 4B Instruct 2507 Q4_K_M
default. Discovery never downloads a model.

See the [llama.cpp provider guide](https://docs.openclaw.ai/plugins/llama-cpp)
for custom GGUF model configuration and hardware guidance.

## Configure embeddings

Set `agents.defaults.memorySearch.provider` to `local`. By default, the plugin
downloads and uses the EmbeddingGemma GGUF model. Configure
`agents.defaults.memorySearch.local.modelPath` to use another local path, Hugging
Face model URI, or HTTPS model URL.

## Package

- Plugin id: `llama-cpp`
- Package: `@openclaw/llama-cpp-provider`
- Minimum OpenClaw host: `2026.6.2`
