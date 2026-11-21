---
summary: "Use an Unsloth Studio API token with OpenClaw"
read_when:
  - You want OpenClaw to call a model served by Unsloth Studio
  - You need to store an Unsloth API token outside openclaw.json
title: "Unsloth"
---

Unsloth Studio serves a local model and expects OpenClaw to call its Anthropic Messages API with a bearer token. Create the key in Unsloth under **Settings → API Keys**. Keys use the `sk-unsloth-` prefix. Put the secret in `UNSLOTH_API_KEY`, not in the config file.

| Property         | Value                                      |
| ---------------- | ------------------------------------------ |
| Provider ID      | `unsloth`                                  |
| API              | `anthropic-messages`                       |
| Auth env var     | `UNSLOTH_API_KEY`                          |
| Default behavior | `Authorization: Bearer` unless `authHeader` is `false` |
| Base URL         | Unsloth origin only, usually `http://127.0.0.1:8888` |

Do not append `/v1`. The Anthropic client adds `/v1/messages` itself.

## Configure

```bash
export UNSLOTH_API_KEY="sk-unsloth-..."
```

On Windows PowerShell:

```powershell
$env:UNSLOTH_API_KEY = "sk-unsloth-..."
```

Keep that variable in the Gateway process environment or `~/.openclaw/.env`. Workspace `.env` files cannot set `UNSLOTH_API_KEY`.

```json5
{
  models: {
    mode: "merge",
    providers: {
      unsloth: {
        baseUrl: "http://127.0.0.1:8888",
        api: "anthropic-messages",
        models: [
          {
            id: "unsloth/Qwen3.6-27B-GGUF",
            name: "unsloth/Qwen3.6-27B-GGUF",
          },
        ],
      },
    },
  },
}
```

Leave `apiKey` unset when `UNSLOTH_API_KEY` is set. OpenClaw reads the token from that variable for the `unsloth` provider and sends it as a bearer token. Set `authHeader: false` only if you need the older `x-api-key` behavior. Set `authHeader: true` if you want the bearer header spelled out in config.

Use the model id you loaded in Unsloth Studio. For remote Unsloth, change `baseUrl` to that machine's origin.
