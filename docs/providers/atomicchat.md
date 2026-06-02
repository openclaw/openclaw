---
summary: "Run OpenClaw with Atomic Chat (OpenAI-compatible local server)"
read_when:
  - You want to run OpenClaw against a local Atomic Chat server
  - You want OpenAI-compatible /v1 endpoints backed by Atomic Chat's local models
title: "Atomic Chat"
---

[Atomic Chat](https://github.com/AtomicBot-ai/Atomic-Chat) is a cross-platform desktop/mobile app that runs open-weight LLMs locally and exposes a single OpenAI-compatible HTTP API. Multiple inference engines (llama.cpp / TurboQuant and MLX-VLM) sit behind one facade, so callers do not need to know which backend is serving a request. OpenClaw connects to Atomic Chat using the `openai-completions` provider family with auto-discovery of available models.

| Property                  | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| Provider id               | `atomicchat`                                                      |
| Plugin                    | bundled, `enabledByDefault: true`                                 |
| Auth env var              | `ATOMIC_CHAT_API_KEY` (any non-empty value if server has no auth) |
| Onboarding flag           | `--auth-choice atomicchat`                                        |
| API                       | OpenAI-compatible (`openai-completions`)                          |
| Default base URL          | `http://127.0.0.1:1337/v1`                                        |
| Default model placeholder | `atomicchat/Qwen/Qwen3-8B`                                        |
| Streaming usage           | Yes (`supportsStreamingUsage: true`)                              |
| Pricing                   | Marked external-free (`modelPricing.external: false`)             |

OpenClaw also **auto-discovers** available models from Atomic Chat when you opt in with `ATOMIC_CHAT_API_KEY`. Use `atomicchat/*` in `agents.defaults.models` to keep discovery dynamic when you also configure a custom Atomic Chat base URL. See [Model discovery (implicit provider)](#model-discovery-implicit-provider) below.

## Getting started

<Steps>
  <Step title="Start Atomic Chat">
    Install and open [Atomic Chat](https://atomic.chat/), download a model, and
    make sure the local server is running. The app exposes an OpenAI-compatible
    server on:

    - `http://127.0.0.1:1337/v1`

    The server is bound to `127.0.0.1` (loopback) by default. Confirm it is up:

    ```bash
    curl http://127.0.0.1:1337/v1/models
    ```

  </Step>
  <Step title="Set an API key">
    Any value works because the local server is unauthenticated by default:

    ```bash
    export ATOMIC_CHAT_API_KEY="atomicchat-local"
    ```

  </Step>
  <Step title="Run onboarding or set a model directly">
    ```bash
    openclaw onboard
    ```

    Or configure the model manually:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "atomicchat/your-model-id" },
        },
      },
    }
    ```

  </Step>
</Steps>

## Model discovery (implicit provider)

When `ATOMIC_CHAT_API_KEY` is set (or an auth profile exists) and you **do not**
define `models.providers.atomicchat`, OpenClaw will query:

- `GET http://127.0.0.1:1337/v1/models`

and convert the returned IDs into model entries.

<Note>
If you set `models.providers.atomicchat` explicitly, OpenClaw uses your declared
models by default. Add `"atomicchat/*": {}` to `agents.defaults.models` when you
want OpenClaw to query that configured provider's `/models` endpoint and include
all advertised Atomic Chat models.
</Note>

## Explicit configuration (manual models)

Use explicit config when:

- Atomic Chat runs on a different host/port.
- You want to pin `contextWindow`/`maxTokens` values.
- Your server requires a real API key (or you want to control headers).

```json5
{
  models: {
    providers: {
      atomicchat: {
        baseUrl: "http://127.0.0.1:1337/v1",
        apiKey: "${ATOMIC_CHAT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local Atomic Chat Model",
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

## Advanced configuration

<AccordionGroup>
  <Accordion title="Proxy-style behavior">
    Atomic Chat is treated as a proxy-style OpenAI-compatible `/v1` backend, not
    a native OpenAI endpoint.

    | Behavior | Atomic Chat |
    |----------|-------------|
    | OpenAI-only request shaping | Not applied |
    | `service_tier`, Responses `store`, prompt-cache hints | Not sent |
    | Reasoning-compat payload shaping | Not applied |
    | Hidden attribution headers (`originator`, `version`, `User-Agent`) | Not injected on custom Atomic Chat base URLs |

  </Accordion>

  <Accordion title="LAN access">
    Atomic Chat binds to loopback by default. To reach it from another machine,
    expose the server on your LAN (`host: 0.0.0.0` in Atomic Chat settings) and
    point `baseUrl` at the reachable address, keeping the `/v1` suffix:

    ```json5
    {
      models: {
        providers: {
          atomicchat: {
            baseUrl: "http://192.168.1.50:1337/v1",
            apiKey: "${ATOMIC_CHAT_API_KEY}",
            api: "openai-completions",
            models: [{ id: "your-model-id", name: "Atomic Chat Model" }],
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Troubleshooting">
    **Server not reachable**

    Verify the server is running and responding:

    ```bash
    curl http://127.0.0.1:1337/v1/models
    ```

    If you see a connection error, open Atomic Chat and confirm the local server
    is started and a model is loaded.

    **Auth errors**

    If requests fail with auth errors, set a real `ATOMIC_CHAT_API_KEY` that
    matches the key configured in Atomic Chat, or configure the provider
    explicitly under `models.providers.atomicchat`.

    <Tip>
    If you run Atomic Chat without authentication (the default), any non-empty
    value for `ATOMIC_CHAT_API_KEY` is sufficient to opt in to model discovery.
    </Tip>

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Local models" href="/gateway/local-models" icon="server">
    Guidance for self-hosted and OpenAI-compatible local servers.
  </Card>
</CardGroup>
