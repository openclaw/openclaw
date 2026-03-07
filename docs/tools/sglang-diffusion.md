---
summary: "Generate images locally with SGLang-Diffusion"
read_when:
  - You want to generate images using a local SGLang-Diffusion server
  - You want local image generation with FLUX, Qwen-Image, or other diffusion models
  - You need OpenAI-compatible /v1/images/generations with your own models
title: "SGLang-Diffusion"
---

# SGLang-Diffusion

[SGLang](https://github.com/sgl-project/sglang) is a fast serving framework for large language models and vision-language models. **SGLang-Diffusion** extends it with high-performance image (and video) generation via diffusion models, exposing an **OpenAI-compatible** HTTP API.

OpenClaw integrates with SGLang-Diffusion through the `image_gen` tool, which calls the `/v1/images/generations` endpoint. When configured, agents can generate images on demand using locally served diffusion models.

## Supported models

SGLang-Diffusion supports a wide range of diffusion models, including:

- **FLUX** — `black-forest-labs/FLUX.1-schnell`, `black-forest-labs/FLUX.1-dev`, `black-forest-labs/FLUX.2-dev`
- **Qwen-Image** — `Qwen/Qwen-Image`, `Qwen/Qwen-Image-2512`
- **Z-Image-Turbo** — `Tongyi-MAI/Z-Image-Turbo`
- **GLM-Image** — `zai-org/GLM-Image`
- Any diffusers-compatible model via `--backend diffusers`

See the [SGLang compatibility matrix](https://docs.sglang.ai/) for the full list.

## Quick start

1. Install SGLang:

```bash
pip install --upgrade pip
pip install sglang
```

2. Start the diffusion server:

```bash
sglang serve --model-path black-forest-labs/FLUX.1-dev --port 30000
```

3. Set the API key (any value works if your server has no auth):

```bash
export SGLANG_DIFFUSION_API_KEY="sglang-local" # pragma: allowlist secret
```

4. Verify the server is reachable:

```bash
curl http://127.0.0.1:30000/v1/models
```

OpenClaw will make the `image_gen` tool available to agents when SGLang-Diffusion is configured. Ask your agent to generate an image and it will use the local SGLang-Diffusion server.

## Onboarding

Run onboarding in manual mode and answer **Yes** to "Configure image generation?":

```bash
openclaw onboard
```

This will prompt for the base URL, API key, and model, then write the configuration to `tools.imageGen`.

## Configuration

SGLang-Diffusion is configured as a **tool integration** under `tools.imageGen`, not as a model provider:

```json5
{
  tools: {
    imageGen: {
      provider: "sglang-diffusion",
      baseUrl: "http://127.0.0.1:30000/v1",
      apiKey: "SGLANG_DIFFUSION_API_KEY", // pragma: allowlist secret
      model: "black-forest-labs/FLUX.1-dev",
    },
  },
}
```

Alternatively, just set the `SGLANG_DIFFUSION_API_KEY` environment variable and OpenClaw will use the default base URL (`http://127.0.0.1:30000/v1`).

The `apiKey` field supports three formats:

- **Literal key** — `"sk-my-secret"` is sent as-is
- **Bare env var name** — `"SGLANG_DIFFUSION_API_KEY"` (this specific name only) is resolved from the environment
- **Interpolation syntax** — `"${MY_CUSTOM_VAR}"` resolves any env var by name

## Advanced options

The `image_gen` tool supports SGLang-Diffusion-specific parameters that the agent can use:

| Parameter             | Description                                     |
| --------------------- | ----------------------------------------------- |
| `prompt`              | Text description of the image to generate       |
| `size`                | Image dimensions (e.g. `1024x1024`, `1024x768`) |
| `negative_prompt`     | What to avoid in the generated image            |
| `num_inference_steps` | Number of diffusion denoising steps             |
| `guidance_scale`      | Classifier-free guidance scale                  |
| `seed`                | Random seed for reproducible generation         |

## Multi-GPU

SGLang-Diffusion supports tensor and data parallelism:

```bash
# Tensor parallelism (2 GPUs)
sglang serve --model-path black-forest-labs/FLUX.1-dev --tp 2 --port 30000

# Data parallelism (2 replicas)
sglang_router.launch_server --model-path black-forest-labs/FLUX.1-dev --dp 2 --port 30000
```

## Docker

SGLang provides official Docker images:

```bash
docker run --gpus all \
    --shm-size 32g \
    -p 30000:30000 \
    -v ~/.cache/huggingface:/root/.cache/huggingface \
    --env "HF_TOKEN=<your-token>" \
    --ipc=host \
    lmsysorg/sglang:latest \
    python3 -m sglang.launch_server --model-path black-forest-labs/FLUX.1-dev --host 0.0.0.0 --port 30000
```

## Relationship to SGLang (text)

SGLang-Diffusion is a **separate server** from SGLang text serving. You can run both simultaneously on different ports:

- **SGLang (text)**: LLM chat completions on port 30000
- **SGLang-Diffusion (images)**: Image generation on a separate port

Each uses its own API key (`SGLANG_API_KEY` vs `SGLANG_DIFFUSION_API_KEY`) and configuration entry.

## Troubleshooting

- **Server not reachable**: Verify with `curl http://127.0.0.1:30000/v1/models`
- **Auth errors**: Ensure `SGLANG_DIFFUSION_API_KEY` matches your server configuration
- **No `image_gen` tool**: The tool only appears when SGLang-Diffusion is configured (via `tools.imageGen` in config or `SGLANG_DIFFUSION_API_KEY` env var)
- **Slow generation**: Try reducing `num_inference_steps` or using a faster model variant
- **FlashInfer issues**: Switch attention backend: `sglang serve --model-path <model> --attention-backend triton --sampling-backend pytorch --port 30000`

## Resources

- [SGLang Documentation](https://docs.sglang.ai/)
- [SGLang GitHub](https://github.com/sgl-project/sglang)
- [SGLang-Diffusion Guide](https://docs.sglang.ai/diffusion/index.html)
- [OpenAI-Compatible Image API](https://docs.sglang.ai/diffusion/api/openai_api.html)
