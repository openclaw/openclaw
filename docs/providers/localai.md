---
summary: "Run OpenClaw with LocalAI (multimodal, scalable local inference with auth)"
read_when:
  - You want to run OpenClaw against a local LocalAI server
  - You want OpenAI-compatible /v1 endpoints with multimodal support
  - You want distributed or P2P federated inference
title: "LocalAI"
---

# LocalAI

[LocalAI](https://localai.io) is a self-hosted, OpenAI-compatible inference server that runs LLMs, vision models, audio, image generation, video generation, and more on consumer hardware. OpenClaw connects to LocalAI using the `openai-completions` API with explicit provider configuration.

LocalAI supports 35+ backends, loads models in GGUF, safetensors, and OCI formats, and runs on NVIDIA (CUDA), AMD (ROCm), Intel (oneAPI/SYCL), Apple Silicon (Metal/MLX), Vulkan, and NVIDIA Jetson — or CPU-only with no GPU at all. It also offers [distributed multi-node inference](https://localai.io/features/distribution/), [P2P federated clusters](https://localai.io/features/distribution/#p2p--federated-inference), a [curated model gallery](https://localai.io/models/), [MCP support](https://localai.io/features/model-context-protocol/), [real-time voice](https://localai.io/features/openai-realtime/), [video generation](https://localai.io/features/video-generation/), embedded vector stores, [fine-tuning](https://localai.io/features/fine-tuning/) workflows, and full [multi-user authentication](https://localai.io/features/authentication/) with OIDC/OAuth provider support. See the [LocalAI feature overview](https://localai.io/features/) for details.

## Quick start

1. Install and start LocalAI. See the [LocalAI quickstart](https://localai.io/basics/getting_started/) for all options including Docker, macOS DMG, and platform-specific packages:

```bash
# Docker (CPU)
docker run -p 8080:8080 --name localai localai/localai:latest-cpu

# Docker (NVIDIA GPU)
docker run -p 8080:8080 --gpus all --name localai localai/localai:latest-gpu-nvidia-cuda-12
```

On macOS, a DMG installer is available from the [LocalAI releases page](https://github.com/mudler/LocalAI/releases).

2. Load a model. Open the LocalAI Web UI at `http://localhost:8080`, navigate to the **Models** section, and install a model from the gallery with one click.

Alternatively, load models from the CLI:

```bash
local-ai run llama-3.2-1b-instruct:q4_k_m
local-ai run huggingface://bartowski/Llama-3.2-1B-Instruct-GGUF/Llama-3.2-1B-Instruct-Q4_K_M.gguf
local-ai run ollama://llama3.2
```

3. Set an API key for the OpenClaw client. If your LocalAI server has [authentication enabled](https://localai.io/features/authentication/), use the matching key here. Otherwise any placeholder value works:

```bash
export LOCALAI_API_KEY="localai-local"
```

<Note>
This variable is read by OpenClaw's config interpolation (`${LOCALAI_API_KEY}`) when connecting to LocalAI. It does not enable auth on the LocalAI server itself. To enable server-side authentication, pass the key to the LocalAI container (for example `-e LOCALAI_API_KEY=...`) or configure it in the [LocalAI server settings](https://localai.io/features/authentication/).
</Note>

4. Configure the LocalAI provider. LocalAI does not have a dedicated provider extension, so auto-discovery is not available. You must define it explicitly as an OpenAI-compatible provider:

```json5
{
  models: {
    providers: {
      localai: {
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "${LOCALAI_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.2-1b-instruct",
            name: "LLaMA 3.2 1B Instruct",
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

5. Set the default model (now that the provider is defined):

```json5
{
  agents: {
    defaults: {
      model: { primary: "localai/llama-3.2-1b-instruct" },
    },
  },
}
```

## Configuration

The provider block from step 4 above is the full explicit configuration. Adjust `baseUrl`, `apiKey`, and the `models` array to match your LocalAI setup.

## Multimodal models

LocalAI can serve vision, audio, TTS, image generation, and video generation models — all through OpenAI-compatible endpoints.

To use a vision model (such as LLaVA) with OpenClaw, mark it as image-capable so OpenClaw auto-injects images into prompts:

```json5
{
  models: {
    providers: {
      localai: {
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "${LOCALAI_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llava-1.6",
            name: "LLaVA 1.6 (Vision)",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4096,
            maxTokens: 2048,
          },
        ],
      },
    },
  },
}
```

With `input: ["text", "image"]`, OpenClaw passes images through to LocalAI's `/v1/chat/completions` endpoint using the standard `image_url` content type.

For audio transcription (`/v1/audio/transcriptions`), TTS (`/v1/audio/speech`), image generation (`/v1/images/generations`), video generation (`/video`), and real-time voice (`/v1/realtime`), see the [LocalAI features documentation](https://localai.io/features/).

## Model selection

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "localai/llama-3.2-1b-instruct",
        fallbacks: ["localai/mistral-7b-instruct"],
      },
    },
  },
}
```

## Proxy-style behavior

LocalAI is treated as a proxy-style OpenAI-compatible `/v1` backend, not a native OpenAI endpoint.

- Native OpenAI-only request shaping does not apply here
- No `service_tier`, no Responses `store`, no prompt-cache hints, and no OpenAI reasoning-compat payload shaping
- Hidden OpenClaw attribution headers (`originator`, `version`, `User-Agent`) are not injected on custom LocalAI base URLs

## Troubleshooting

### LocalAI not detected or connection refused

Make sure LocalAI is running and reachable. The default port is `8080`:

```bash
curl http://localhost:8080/v1/models

# Verify the process is listening
ss -ltnp | grep 8080
```

If LocalAI runs on a non-default port, update `baseUrl` in your provider config to match.

### No models available

Open the Web UI at `http://localhost:8080` to browse and install models from the gallery, or use the API:

```bash
curl http://localhost:8080/models/apply -H "Content-Type: application/json" \
  -d '{"id": "llama-3.2-1b-instruct"}'
```

## See Also

- [LocalAI documentation](https://localai.io)
- [LocalAI GitHub](https://github.com/mudler/LocalAI)
- [LocalAI model gallery](https://models.localai.io)
- [Model Providers](/concepts/model-providers) - Overview of all providers
- [Model Selection](/concepts/models) - How to choose models
- [Configuration](/gateway/configuration) - Full config reference
