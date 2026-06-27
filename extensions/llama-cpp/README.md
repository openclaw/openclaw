# @openclaw/llama-cpp-provider

Official llama.cpp embedding provider for OpenClaw.

This plugin runs local GGUF embedding models through `node-llama-cpp`.

## Install

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

Restart the Gateway after installing or updating the plugin. Use Node 24 for
native installs and updates.

## Configure

Set `agents.defaults.memorySearch.provider` to `local`. By default, the plugin
downloads and uses the EmbeddingGemma GGUF model. Configure
`agents.defaults.memorySearch.local.modelPath` to use another local path, Hugging
Face model URI, or HTTPS model URL.

## Package

- Plugin id: `llama-cpp`
- Package: `@openclaw/llama-cpp-provider`
- Minimum OpenClaw host: `2026.6.2`
