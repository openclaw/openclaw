---
summary: "Use Rapid-MLX for local chat and memory embeddings on Apple Silicon"
read_when:
  - You want to use Rapid-MLX with OpenClaw
  - You want local memory embeddings on an Apple Silicon Mac
title: "Rapid-MLX"
---

[Rapid-MLX](https://github.com/raullenchai/Rapid-MLX) is an open-source local LLM
inference server for Apple Silicon, built on MLX. OpenClaw's bundled Rapid-MLX
provider supports chat and memory embeddings through its OpenAI-compatible API
at `http://localhost:8000/v1`.

## Quick start

### Install and start Rapid-MLX

```bash
brew install rapid-mlx
rapid-mlx serve qwen3.5-4b-4bit --port 8000
```

Rapid-MLX downloads models from Hugging Face into the standard Hugging Face cache.
You can also install it with `pip install rapid-mlx` (Python 3.12+) or use the
[native macOS desktop app](https://rapidmlx.com/desktop).
See the [Rapid-MLX documentation](https://rapidmlx.com/docs/) for setup details.

Without `--port`, Rapid-MLX selects the first free port in 8000–8009. The explicit
port above keeps OpenClaw's default URL predictable. If another service already
uses port 8000, choose another port and enter its URL during OpenClaw setup.

Check the models exposed by the running server:

```bash
curl http://localhost:8000/v1/models
```

Use an exact `id` returned by this endpoint, such as
`mlx-community/Qwen3.5-4B-MLX-4bit`.

### Connect OpenClaw

```bash
openclaw models auth login --provider rapid-mlx
```

Confirm the server URL, leave the API key blank when authentication is disabled,
and choose a chat model. Alternatively, run `openclaw onboard` and choose
**Rapid-MLX**. Guided setup detects the running local server and discovers models
through `/v1/models`, including their reported context windows.

Entering a new key replaces saved request authentication, including custom
headers. An explicitly blank key disables authentication. In noninteractive
setup, omit `--custom-api-key` to reuse the saved connection, or pass
`--custom-api-key ""` to clear its authentication.

Chat model references use the `rapid-mlx/` prefix:

```bash
openclaw models set "rapid-mlx/mlx-community/Qwen3.5-4B-MLX-4bit"
```

Setup saves the connection and preserves authored model overrides; discovered
catalog rows stay live rather than being copied into configuration. When the
server advertises `max_model_len`, selection and runtime budgets use that served
ceiling, capped by the native `context_window`. Embedding-only rows are excluded
from the chat picker.

## Memory embeddings

Serve an embedding model with Rapid-MLX, then set its exact `/v1/models` ID in
`memory.search.model`. The chat model and embedding model are separate choices;
select an embedding model for memory search.

```json5
{
  memory: {
    search: {
      provider: "rapid-mlx",
      model: "<embedding-model-id>", // Replace with the served embedding model's ID.
    },
  },
}
```

After switching embedding providers or models, rebuild the index and verify it:

```bash
openclaw memory index --force
openclaw memory status --deep
openclaw memory search "a fact from your notes"
```

Switching from `openai-compatible` to the named `rapid-mlx` provider changes the
index identity, even when both use the same server and model.
Rapid-MLX owns model downloads, loading, and server lifecycle. OpenClaw sends
embedding requests to `/v1/embeddings` and does not install models.

## Server URL and authentication

To use a different port or host, set `models.providers.rapid-mlx.baseUrl`.
Both chat and memory embeddings reuse the provider connection saved by setup:

```json5
{
  models: {
    providers: {
      "rapid-mlx": {
        baseUrl: "http://localhost:8001/v1",
        api: "openai-completions",
        models: [],
      },
    },
  },
}
```

Keep `/v1` on the base URL. Rapid-MLX requires no key by default. If you enable
authentication on the server, set `RAPID_MLX_API_KEY` in the Gateway environment
or configure `models.providers.rapid-mlx.apiKey`. For an authenticated memory-only
connection, set `memory.search.remote.apiKey` explicitly, for example to
`"${RAPID_MLX_API_KEY}"`; the environment variable alone does not configure
memory authentication.

## Non-interactive onboarding

Pass the chat model ID without the `rapid-mlx/` provider prefix:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --skip-health \
  --auth-choice rapid-mlx \
  --custom-base-url http://localhost:8000/v1 \
  --custom-model-id "mlx-community/Qwen3.5-4B-MLX-4bit"
```

For an authenticated server, also pass `--custom-api-key "$RAPID_MLX_API_KEY"`.
Configure the embedding model separately under `memory.search`.

## Troubleshooting

- **Connection refused:** check the host and port against
  `curl http://localhost:8000/v1/models`. An automatically selected server port
  may differ from OpenClaw's default; enter the actual URL during setup.
- **HTTP 401:** set the key required by your server.
- **Embedding request rejected:** serve an embedding model and use its exact
  `/v1/models` ID, without the `rapid-mlx/` provider prefix.
- **Index identity warning after switching models:** run
  `openclaw memory index --force` to rebuild with the new embeddings.

## Related

- [Memory search](/concepts/memory-search)
- [Memory configuration](/reference/memory-config)
- [Model selection](/concepts/models)
- [Local models](/gateway/local-models)
