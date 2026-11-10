---
summary: "Use local models from the Llama app, llama.cpp's desktop app"
read_when:
  - You want to use the Llama app with OpenClaw
  - You want to run local GGUF models without managing llama-server yourself
title: "Llama"
---

[Llama](https://llama.app) is llama.cpp's desktop app for macOS and Windows. It
downloads GGUF models from Hugging Face and serves them through llama-server at
`http://127.0.0.1:9931/v1`. OpenClaw's bundled Llama provider discovers the
models you have in the app and uses its OpenAI-compatible API.

## Quick start

### Install Llama and download a model

Install Llama from [llama.app](https://llama.app) and download a chat model in
the app. Llama loads a model on its first request and unloads it when idle, so
the app only needs to be running.

OpenClaw's system prompt and tools take about 16K tokens before your first
message. In Llama, give the model a context size of at least 32K.

### Connect OpenClaw

Run `openclaw onboard` and choose **Llama**. Guided setup detects the running
app and offers its models, preferring one already loaded in the app.

To connect from the terminal instead:

```bash
openclaw models auth login --provider llama
```

Leave the URL blank to use the default, then choose a model.

Model references use the `llama/` prefix with the model's ID in the app:

```bash
openclaw models list --provider llama
openclaw models set "llama/ggml-org/gemma-4-E4B-it-GGUF:Q8_0"
```

OpenClaw lists models live from the app, so models you add in Llama appear
without rerunning setup.

## Non-interactive onboarding

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice llama \
  --custom-model-id "ggml-org/gemma-4-E4B-it-GGUF:Q8_0"
```

Omit `--custom-model-id` to pick a model automatically. If you changed the port
in Llama's settings, pass `--custom-base-url http://127.0.0.1:<port>/v1`.

## Troubleshooting

- **Llama isn't reachable:** open the Llama app. If you changed its port, update
  `models.providers.llama.baseUrl` or rerun setup with the new URL.
- **Context overflow:** increase the model's context size in Llama, then retry.
- **No models found:** download a chat model in Llama. OpenClaw lists only chat
  models.

## Related

- [llama.cpp](/plugins/llama-cpp), to run and manage llama-server yourself
- [Local models](/gateway/local-models)
- [Model selection](/concepts/models)
