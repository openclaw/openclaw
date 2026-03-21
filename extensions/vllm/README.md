# vLLM Provider

Bundled provider plugin that connects OpenClaw to a local or self-hosted
[vLLM](https://docs.vllm.ai/) server via its OpenAI-compatible API.

## Enabling

vLLM is a bundled plugin and ships with every OpenClaw install. No extra
installation step is required.

To opt in, export the environment variable (any value works when the server
does not enforce authentication):

```bash
export VLLM_API_KEY="vllm-local"
```

Then run `openclaw onboard` and choose **vLLM**, or set the model directly:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vllm/your-model-id" },
    },
  },
}
```

## Configuration

By default OpenClaw connects to `http://127.0.0.1:8000/v1`. If your vLLM
server runs elsewhere, add an explicit provider entry:

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://your-host:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local vLLM Model",
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

When no explicit provider entry exists and `VLLM_API_KEY` is set, OpenClaw
auto-discovers models by querying `GET /v1/models` on the default base URL.

## Environment variables

| Variable       | Purpose                                   |
| -------------- | ----------------------------------------- |
| `VLLM_API_KEY` | API key sent to the vLLM server           |

## Docs

Full documentation: <https://docs.openclaw.ai/providers/vllm>

Plugin system overview: <https://docs.openclaw.ai/plugin>
