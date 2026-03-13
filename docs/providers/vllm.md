---
summary: "Run OpenClaw with vLLM (OpenAI-compatible local server)"
read_when:
  - You want to run OpenClaw against a local vLLM server
  - You want OpenAI-compatible /v1 endpoints with your own models
title: "vLLM"
---

# vLLM

vLLM can serve open-source (and some custom) models via an **OpenAI-compatible** HTTP API. OpenClaw can connect to vLLM using the `openai-completions` API.

OpenClaw can also **auto-discover** available models from vLLM when you opt in with `VLLM_API_KEY` (any value works if your server doesn’t enforce auth) and you do not define an explicit `models.providers.vllm` entry.

Interactive setup now supports:

- Reusing the last saved base URL when you update an existing vLLM endpoint
- Scanning `/v1/models` after you enter a base URL and API key
- Selecting one or more discovered models to save
- Managing multiple vLLM endpoints from the setup menu

## Quick start

1. Start vLLM with an OpenAI-compatible server.

Your base URL should expose `/v1` endpoints (e.g. `/v1/models`, `/v1/chat/completions`). vLLM commonly runs on:

- `http://127.0.0.1:8000/v1`

2. Opt in (any value works if no auth is configured):

```bash
export VLLM_API_KEY="vllm-local"
```

3. Select a model (replace with one of your vLLM model IDs):

```json5
{
  agents: {
    defaults: {
      model: { primary: "vllm/your-model-id" },
    },
  },
}
```

## Model discovery (implicit provider)

When `VLLM_API_KEY` is set (or an auth profile exists) and you **do not** define `models.providers.vllm`, OpenClaw will query:

- `GET http://127.0.0.1:8000/v1/models`

…and convert the returned IDs into model entries.

If `/v1/models` returns multiple IDs, OpenClaw converts **all** of them into model entries for the implicit `vllm` provider. You can then point `agents.defaults.model.primary` at any discovered `vllm/<model-id>` reference.

If you set `models.providers.vllm` explicitly, auto-discovery is skipped and you must define models manually.

If you manage multiple explicit vLLM endpoints, any explicit provider key that starts with `vllm` such as `vllm`, `vllm-2`, or `vllm-3` also suppresses the implicit single-endpoint auto-discovery path.

## Interactive setup

Run `openclaw configure` or onboard through the model picker, then choose **vLLM**.

The setup menu can:

- Use a previously configured vLLM model
- Add a new vLLM endpoint
- Update an existing endpoint and rescan its models
- Delete an existing endpoint

When you update an existing endpoint, the base URL field is pre-filled with the last saved value. If you leave the API key blank during an update, OpenClaw keeps the saved key and still uses it for model discovery.

When discovery succeeds, OpenClaw shows all models returned by `/v1/models` and lets you select one or more models to keep. If multiple models are selected, you also choose which one becomes the default reference returned from setup.

Each saved endpoint is stored under its own provider key:

- First endpoint: `vllm`
- Second endpoint: `vllm-2`
- Third endpoint: `vllm-3`

That means model refs look like:

- `vllm/meta-llama/Meta-Llama-3-8B-Instruct`
- `vllm-2/deepseek-ai/DeepSeek-R1`

## Explicit configuration (manual models)

Use explicit config when:

- vLLM runs on a different host/port.
- You want to pin `contextWindow`/`maxTokens` values.
- Your server requires a real API key (or you want to control headers).
- You want to manage multiple vLLM endpoints at the same time.

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local vLLM Model",
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

### Multiple explicit vLLM endpoints

If you run more than one vLLM server, define each endpoint under its own provider key and reference models by that key:

```json5
{
  models: {
    mode: "merge",
    providers: {
      vllm: {
        baseUrl: "http://gpu-a:8000/v1",
        api: "openai-completions",
        models: [
          {
            id: "meta-llama/Meta-Llama-3-8B-Instruct",
            name: "Llama 3 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
      "vllm-2": {
        baseUrl: "http://gpu-b:8000/v1",
        api: "openai-completions",
        models: [
          {
            id: "deepseek-ai/DeepSeek-R1",
            name: "DeepSeek R1",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "vllm-2/deepseek-ai/DeepSeek-R1" },
    },
  },
}
```

## Troubleshooting

- Check the server is reachable:

```bash
curl http://127.0.0.1:8000/v1/models
```

- If requests fail with auth errors, set a real `VLLM_API_KEY` that matches your server configuration, or configure the provider explicitly under `models.providers.vllm`.
- If discovery returns no models, confirm the endpoint exposes `GET /v1/models` and that the saved or entered API key is accepted by that server.
