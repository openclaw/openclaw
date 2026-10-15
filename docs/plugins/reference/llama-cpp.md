---
summary: "Managed and external llama.cpp servers for GGUF chat, embeddings and local images."
read_when:
  - You are installing, configuring, or auditing the llama-cpp plugin
title: "Llama Cpp plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Managed and external llama.cpp servers for GGUF chat, embeddings and local images.

## Distribution

- Package: `@openclaw/llama-cpp-provider`
- Install route: npm or ClawHub: `clawhub:@openclaw/llama-cpp-provider`

## Surface

- Providers: `llama-cpp`
- Contracts: `embeddingProviders`, `mediaUnderstandingProviders`, `tools`

<!-- openclaw-plugin-reference:manual-start -->

## Managed text models

During interactive setup, OpenClaw installs a pinned, verified `llama-server`
and recommends a model for the Gateway host's available memory, GPU, and disk
space. Recommendations start with Qwen3.5 4B (about 2.7 GB) on eligible 8 GiB
hosts and scale up as hardware permits. See the current
[model recommendations](/plugins/llama-cpp#model-recommendations) for sizes and
selection floors.

To use another model, configure `params.modelPath`, select its `llama-cpp/<id>`
reference, and rerun managed setup. Setup uses that authored route and offers
to download it if needed. Custom models are not subject to recommendation
memory floors. Existing cached GGUFs remain supported; local memory search can
also use [embedding-only setup](/plugins/llama-cpp#set-up-only-local-embeddings).

<!-- openclaw-plugin-reference:manual-end -->

## Related docs

- [llama-cpp](/plugins/llama-cpp)
