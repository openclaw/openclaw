# vLLM Provider

Bundled provider plugin for [vLLM](https://docs.vllm.ai/) discovery and setup.
vLLM is a high-throughput, memory-efficient inference engine for LLMs that
exposes an OpenAI-compatible API.

## Enable

The vLLM plugin is bundled and enabled by default. If disabled, re-enable with:

```bash
openclaw plugins enable vllm
```

## Authenticate

Interactive setup:

```bash
openclaw setup --wizard --auth-choice vllm
```

Non-interactive:

```bash
openclaw models auth login --provider vllm \
  --base-url http://localhost:8000/v1 \
  --model my-model \
  --set-default
```

Set the `VLLM_API_KEY` environment variable if your vLLM server requires
authentication.

## Config

Provider configuration lives in the main `openclaw.json` under `providers`:

```json5
{
  providers: {
    vllm: {
      baseUrl: "http://localhost:8000/v1",
      model: "my-model",
      apiKeyEnvVar: "VLLM_API_KEY", // optional
    },
  },
}
```

Default base URL: `http://localhost:8000/v1`

## Auto-discovery

The plugin probes the default vLLM endpoint on startup. If a running vLLM
server is detected, it registers automatically as an available provider.

## Full documentation

See https://docs.openclaw.ai/providers/vllm for:

- Server setup and model serving
- Custom base URLs and API keys
- Model selection and failover
- Troubleshooting
