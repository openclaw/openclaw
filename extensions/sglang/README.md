# SGLang Provider

Bundled provider plugin for [SGLang](https://github.com/sgl-project/sglang)
discovery and setup. SGLang is a fast serving framework for large language
models that exposes an OpenAI-compatible API.

## Enable

The SGLang plugin is bundled and enabled by default. If disabled, re-enable with:

```bash
openclaw plugins enable sglang
```

## Authenticate

Interactive setup:

```bash
openclaw setup --wizard --auth-choice sglang
```

Non-interactive:

```bash
openclaw models auth login --provider sglang \
  --base-url http://localhost:30000/v1 \
  --model my-model \
  --set-default
```

Set the `SGLANG_API_KEY` environment variable if your SGLang server requires
authentication.

## Config

Provider configuration lives in the main `openclaw.json` under `providers`:

```json5
{
  providers: {
    sglang: {
      baseUrl: "http://localhost:30000/v1",
      model: "my-model",
      apiKeyEnvVar: "SGLANG_API_KEY", // optional
    },
  },
}
```

Default base URL: `http://localhost:30000/v1`

## Auto-discovery

The plugin probes the default SGLang endpoint on startup. If a running SGLang
server is detected, it registers automatically as an available provider.

## Full documentation

See https://docs.openclaw.ai/providers/sglang for:

- Server setup and model serving
- Custom base URLs and API keys
- Model selection and failover
- Troubleshooting
