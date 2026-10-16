---
summary: "Use oMLX for local chat and memory embeddings on Apple Silicon"
read_when:
  - You want to use oMLX with OpenClaw
  - You want local memory embeddings on an Apple Silicon Mac
title: "oMLX"
---

[oMLX](https://github.com/jundot/omlx) serves MLX models on Apple Silicon.
OpenClaw's bundled oMLX provider supports chat and memory embeddings through
its OpenAI-compatible API at `http://127.0.0.1:8000/v1`.

## Quick start

### Install and start oMLX

Install oMLX with Homebrew:

```bash
brew tap jundot/omlx https://github.com/jundot/omlx
brew install jundot/omlx/omlx
omlx serve --model-dir ~/models
```

Download a supported MLX chat model and an embedding model into your model
directory. See the [oMLX installation and model guide](https://github.com/jundot/omlx#install)
for the macOS app, source installation, and models. Native custom kernels are
optional for some models and require full Xcode when built locally.

Check the models exposed by the running server:

```bash
curl http://127.0.0.1:8000/v1/models
```

Use the exact `id` values returned by this endpoint. A model alias configured
in oMLX is also an API-visible ID; it may differ from the download directory.

### Connect OpenClaw

```bash
openclaw models auth login --provider omlx
```

Confirm the server URL, leave the API key blank for a local server with
authentication disabled, and choose a chat model. Alternatively, run
`openclaw onboard` and choose **oMLX**. Guided setup detects the running local
server and discovers models through `/v1/models`.

Entering a new key replaces saved request authentication, including custom
headers. An explicitly blank key disables authentication. In noninteractive
setup, omit `--custom-api-key` to reuse the saved connection, or pass
`--custom-api-key ""` to clear its authentication.

The inference catalog does not report model types, so it can also list embedding
models. Choose a chat model for conversations and configure the embedding model
separately below.

Chat model references use the `omlx/` prefix:

```bash
openclaw models set "omlx/<chat-model-id>"
```

## Memory embeddings

Choose an embedding model served by oMLX, then set its exact API-visible ID in
`memory.search.model`. The chat model and embedding model are separate choices;
a chat model cannot produce memory embeddings.

```json5
{
  memory: {
    search: {
      provider: "omlx",
      model: "bge-m3", // Replace with your embedding model's /v1/models ID.
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

oMLX owns model loading. OpenClaw sends embedding requests to `/v1/embeddings`
and does not install models or call oMLX management endpoints.

## Server URL and authentication

The default endpoint needs no configuration. To use a different port or host,
set `models.providers.omlx.baseUrl`. Both chat and memory embeddings use this
provider configuration:

```json5
{
  models: {
    providers: {
      omlx: {
        baseUrl: "http://127.0.0.1:8001/v1",
        api: "openai-completions",
        models: [],
      },
    },
  },
}
```

Keep `/v1` on the base URL. For authenticated chat, set `OMLX_API_KEY` in the
Gateway environment or configure `models.providers.omlx.apiKey`. Embeddings
reuse the provider connection saved by setup. For an authenticated memory-only
setup, set `memory.search.remote.apiKey`, for example to `"${OMLX_API_KEY}"`;
the environment variable alone does not configure memory authentication.
No real key is required when authentication is disabled on a local server.

## Non-interactive onboarding

Pass the chat model ID without the `omlx/` prefix:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --skip-health \
  --auth-choice omlx \
  --custom-base-url http://127.0.0.1:8000/v1 \
  --custom-model-id "<chat-model-id>"
```

For an authenticated server, also pass `--custom-api-key "$OMLX_API_KEY"`.
Configure the embedding model separately under `memory.search`.

## Troubleshooting

- **Connection refused:** start oMLX and check that the configured host and port
  match `curl http://127.0.0.1:8000/v1/models`.
- **HTTP 401:** set the key required by your server. Leave it blank only when
  the server permits unauthenticated requests.
- **Embedding model rejected:** use the exact ID of an embedding model in
  `/v1/models`, not a chat model or its `omlx/` chat reference.
- **Index identity warning after switching models:** run
  `openclaw memory index --force` to rebuild with the new embeddings.

## Related

- [Memory search](/concepts/memory-search)
- [Memory configuration](/reference/memory-config)
- [Model selection](/concepts/models)
- [Local models](/gateway/local-models)
