---
summary: "Run OpenClaw with SGLang (OpenAI-compatible local server)"
read_when:
  - You want to run OpenClaw against a local SGLang server
  - You want OpenAI-compatible /v1 endpoints with your own models
  - You need high-throughput, low-latency local inference
title: "SGLang"
---

# SGLang

SGLang is a fast serving framework for large language models and vision-language models. It provides an **OpenAI-compatible** HTTP API for seamless integration. OpenClaw can connect to SGLang using the `openai-completions` API.

OpenClaw can also **auto-discover** available models from SGLang when you opt in with `SGLANG_API_KEY` (any value works if your server doesn't enforce auth) and you do not define an explicit `models.providers.sglang` entry.

## Quick start

1. Start SGLang with an OpenAI-compatible server.

```bash
python3 -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --host 0.0.0.0 --port 30000
```

Your base URL should expose `/v1` endpoints (e.g. `/v1/models`, `/v1/chat/completions`). SGLang commonly runs on:

- `http://127.0.0.1:30000/v1`

2. Opt in (any value works if no auth is configured):

```bash
export SGLANG_API_KEY="sglang-local"
```

3. Select a model (replace with one of your SGLang model IDs):

```json5
{
  agents: {
    defaults: {
      model: { primary: "sglang/your-model-id" },
    },
  },
}
```

## Model discovery (implicit provider)

When `SGLANG_API_KEY` is set (or an auth profile exists) and you **do not** define `models.providers.sglang`, OpenClaw will query:

- `GET http://127.0.0.1:30000/v1/models`

…and convert the returned IDs into model entries.

If you set `models.providers.sglang` explicitly, auto-discovery is skipped and you must define models manually.

## Explicit configuration (manual models)

Use explicit config when:

- SGLang runs on a different host/port.
- You want to pin `contextWindow`/`maxTokens` values.
- Your server requires a real API key (or you want to control headers).

```json5
{
  models: {
    providers: {
      sglang: {
        baseUrl: "http://127.0.0.1:30000/v1",
        apiKey: "${SGLANG_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local SGLang Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Advanced SGLang features

SGLang supports several advanced features that can improve performance:

### Multi-GPU tensor parallelism

```bash
python3 -m sglang.launch_server --model-path meta-llama/Meta-Llama-3-8B-Instruct --tp 2 --port 30000
```

### Multi-GPU data parallelism

For better throughput with multiple GPUs, use data parallelism:

```bash
python3 -m sglang_router.launch_server --model-path meta-llama/Meta-Llama-3-8B-Instruct --dp 2 --port 30000
```

### Configuration file

Create a YAML config file for easier server management:

```yaml
# config.yaml
model-path: meta-llama/Meta-Llama-3-8B-Instruct
host: 0.0.0.0
port: 30000
tensor-parallel-size: 2
enable-metrics: true
log-requests: true
```

```bash
python3 -m sglang.launch_server --config config.yaml
```

## Docker deployment

SGLang provides official Docker images at [lmsysorg/sglang](https://hub.docker.com/r/lmsysorg/sglang/tags):

```bash
docker run --gpus all \
    --shm-size 32g \
    -p 30000:30000 \
    -v ~/.cache/huggingface:/root/.cache/huggingface \
    --env "HF_TOKEN=<your-token>" \
    --ipc=host \
    lmsysorg/sglang:latest \
    python3 -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --host 0.0.0.0 --port 30000
```

For production deployments, use the `runtime` variant which is ~40% smaller:

```bash
docker run --gpus all \
    --shm-size 32g \
    -p 30000:30000 \
    -v ~/.cache/huggingface:/root/.cache/huggingface \
    --env "HF_TOKEN=<your-token>" \
    --ipc=host \
    lmsysorg/sglang:latest-runtime \
    python3 -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --host 0.0.0.0 --port 30000
```

## Troubleshooting

- Check the server is reachable:

```bash
curl http://127.0.0.1:30000/v1/models
```

- View API documentation (when server is running):
  - Swagger UI: `http://localhost:30000/docs`
  - ReDoc: `http://localhost:30000/redoc`
  - OpenAPI spec: `http://localhost:30000/openapi.json`

- If requests fail with auth errors, set a real `SGLANG_API_KEY` that matches your server configuration, or configure the provider explicitly under `models.providers.sglang`.

- For FlashInfer-related issues on sm75+ devices (T4, A10, A100, L4, L40S, H100), switch to alternative kernels:

```bash
python3 -m sglang.launch_server --model-path <model> --attention-backend triton --sampling-backend pytorch --port 30000
```

## Installation

Install SGLang using pip or uv:

```bash
pip install --upgrade pip
pip install uv
uv pip install sglang
```

For more installation options (from source, Docker, platform-specific), see the [SGLang installation guide](https://docs.sglang.ai/get_started/install.html).

## Resources

- [SGLang Documentation](https://docs.sglang.ai/)
- [SGLang GitHub](https://github.com/sgl-project/sglang)
- [OpenAI-Compatible API Guide](https://docs.sglang.ai/basic_usage/openai_api.html)
- [Server Arguments Reference](https://docs.sglang.ai/advanced_features/server_arguments.html)
