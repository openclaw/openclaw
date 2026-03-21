# SGLang Provider

Bundled provider plugin that connects OpenClaw to a local or self-hosted
[SGLang](https://github.com/sgl-project/sglang) server via its
OpenAI-compatible API.

## Enabling

SGLang is a bundled plugin and ships with every OpenClaw install. No extra
installation step is required.

To opt in, export the environment variable (any value works when the server
does not enforce authentication):

```bash
export SGLANG_API_KEY="sglang-local"
```

Then run `openclaw onboard` and choose **SGLang**, or set the model directly:

```json5
{
  agents: {
    defaults: {
      model: { primary: "sglang/your-model-id" },
    },
  },
}
```

## Configuration

By default OpenClaw connects to `http://127.0.0.1:30000/v1`. If your SGLang
server runs elsewhere, add an explicit provider entry:

```json5
{
  models: {
    providers: {
      sglang: {
        baseUrl: "http://your-host:30000/v1",
        apiKey: "${SGLANG_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local SGLang Model",
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

When no explicit provider entry exists and `SGLANG_API_KEY` is set, OpenClaw
auto-discovers models by querying `GET /v1/models` on the default base URL.

## Environment variables

| Variable         | Purpose                                     |
| ---------------- | ------------------------------------------- |
| `SGLANG_API_KEY` | API key sent to the SGLang server           |

## Docs

Full documentation: <https://docs.openclaw.ai/providers/sglang>

Plugin system overview: <https://docs.openclaw.ai/plugin>
