---
title: "Azure OpenAI"
summary: "Use Azure OpenAI models (GPT-5.2, GPT-5.2-Codex) with OpenClaw"
read_when:
  - You want to use Azure OpenAI models in OpenClaw
  - You need Azure OpenAI authentication or endpoint setup
---

# Azure OpenAI

OpenClaw can use **Azure OpenAI** models via the Azure OpenAI v1 API endpoint.
Azure uses a different authentication scheme (`api-key` header) than the standard
OpenAI `Authorization: Bearer` header, so manual provider configuration is required.

- Provider: `azure-openai-responses`
- API: `openai-responses`
- Auth: `api-key` HTTP header (not `Authorization: Bearer`)

## Prerequisites

- An Azure OpenAI resource with deployed models (e.g. `gpt-5.2-codex`, `gpt-5.2`)
- Your Azure OpenAI API key
- Your Azure OpenAI resource endpoint (e.g. `https://<resource>.openai.azure.com`)

## Setup

### Step 1: Run the onboard command

```bash
openclaw onboard --install-daemon
```

When prompted to select a model, choose **Skip for now**. On the provider page,
select `azure-openai-responses` and pick `gpt-5.2-codex` as the model.

### Step 2: Configure openclaw.json

Open `~/.openclaw/openclaw.json` and configure the provider:

```json5
{
  models: {
    providers: {
      "azure-openai-responses": {
        baseUrl: "https://<resource>.openai.azure.com/openai/v1",
        apiKey: "<AZURE_OPENAI_API_KEY>",
        api: "openai-responses",
        authHeader: false,
        headers: {
          "api-key": "<AZURE_OPENAI_API_KEY>",
        },
        models: [
          {
            id: "gpt-5.2-codex",
            name: "GPT-5.2-Codex (Azure)",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
            contextWindow: 400000,
            maxTokens: 16384,
            compat: { supportsStore: false },
          },
          {
            id: "gpt-5.2",
            name: "GPT-5.2 (Azure)",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
            contextWindow: 272000,
            maxTokens: 16384,
            compat: { supportsStore: false },
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "azure-openai-responses/gpt-5.2-codex" },
    },
  },
}
```

The model `id` must match your Azure deployment name exactly.

### Step 3: Restart the gateway

```bash
openclaw gateway restart
```

## Authentication

Azure OpenAI uses the `api-key` HTTP header instead of the standard
`Authorization: Bearer` header. The configuration handles this with two settings:

- `authHeader: false` disables the default `Authorization: Bearer <key>` header.
- `headers: { "api-key": "<key>" }` sends the API key via Azure's native header.

The API key must appear in both the `apiKey` field (for OpenClaw internals) and
the `headers["api-key"]` field (sent to Azure).

## Base URL

Azure OpenAI's v1-compatible endpoint:

```
https://<resource>.openai.azure.com/openai/v1
```

This endpoint does not require an `api-version` query parameter.

## Compatibility flags

- `supportsStore: false` — Azure OpenAI does not support the OpenAI Responses API
  `store` parameter. This flag prevents OpenClaw from including it in requests.

## Reasoning effort

Both GPT-5.2-Codex and GPT-5.2 are reasoning-capable models. You can control the
thinking level in three ways (highest priority first):

1. **Inline directive** — add `/think:<level>` in your message (e.g. `/think:high explain quicksort`). Applies to that message only.
2. **Session default** — send `/think:medium` as a standalone message. Persists for the session until changed.
3. **Global config** — set `thinkingDefault` in `agents.defaults`:

```json5
{
  agents: {
    defaults: {
      thinkingDefault: "low",
    },
  },
}
```

Available levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

If nothing is set, reasoning models default to `low`.

See [Thinking Levels](/tools/thinking) for full details.

## Model specifications

| Model         | Context Window | Max Output Tokens | Image Input | Reasoning |
| ------------- | -------------- | ----------------- | ----------- | --------- |
| gpt-5.2-codex | 400,000        | 16,384            | Yes         | Yes       |
| gpt-5.2       | 272,000        | 16,384            | Yes         | Yes       |

## Troubleshooting

**Agent runs but returns empty responses**

- Verify `api` is set to `"openai-responses"` for both models.
- Verify `authHeader` is set to `false`.
- Verify the `api-key` header is present in `headers`.
- Test your endpoint directly:

```bash
curl -X POST "https://<resource>.openai.azure.com/openai/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "api-key: <AZURE_OPENAI_API_KEY>" \
  -d '{"model":"gpt-5.2","messages":[{"role":"user","content":"hello"}]}'
```

**Agent completes in ~4ms with no output**

The `api` field is likely missing. Ensure `"api": "openai-responses"` is set on
the provider.

## Notes

- Model refs use `provider/model` format (see [Models](/concepts/models)).
- Cost fields are in USD per 1M tokens. Set to `0` if you do not need cost tracking.
- Adjust `contextWindow` and `maxTokens` if your Azure deployment has different limits.
