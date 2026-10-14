---
summary: "Cerebras setup (auth + model selection)"
title: "Cerebras"
read_when:
  - You want to use Cerebras with OpenClaw
  - You need the Cerebras API key env var or CLI auth choice
---

[Cerebras](https://www.cerebras.ai) provides high-speed OpenAI-compatible inference on custom inference hardware. The plugin discovers native model metadata and pricing, with a bundled catalog for offline fallback.

| Property        | Value                                                     |
| --------------- | --------------------------------------------------------- |
| Provider id     | `cerebras`                                                |
| Plugin          | official external package (`@openclaw/cerebras-provider`) |
| Auth env var    | `CEREBRAS_API_KEY`                                        |
| Onboarding flag | `--auth-choice cerebras-api-key`                          |
| Direct CLI flag | `--cerebras-api-key <key>`                                |
| API             | OpenAI-compatible (`openai-completions`)                  |
| Base URL        | `https://api.cerebras.ai/v1`                              |
| Default model   | `cerebras/gpt-oss-120b`                                   |

## Install plugin

```bash
openclaw plugins install @openclaw/cerebras-provider
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an API key in the [Cerebras Cloud Console](https://cloud.cerebras.ai).
  </Step>
  <Step title="Run onboarding">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice cerebras-api-key
```

```bash Direct flag
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice cerebras-api-key \
  --cerebras-api-key "$CEREBRAS_API_KEY"
```

```bash Env only
export CEREBRAS_API_KEY=csk-...
```

    </CodeGroup>

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider cerebras
    ```

    Lists the configured Cerebras models. If `CEREBRAS_API_KEY` is unresolved, `openclaw models status --json` reports the missing credential under `auth.unusableProfiles`.

  </Step>
</Steps>

## Non-interactive setup

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice cerebras-api-key \
  --cerebras-api-key "$CEREBRAS_API_KEY"
```

`--mode` defaults to `local`, so this is the same run as the **Direct flag**
command above. Run it on the Gateway host: remote-client onboarding
(`--mode remote`) only configures the local client connection and does not set
up provider credentials on the server.

## Discovery and pricing

When Cerebras auth is configured and the inference base URL is the canonical
`https://api.cerebras.ai/v1`, OpenClaw reads
[`GET /public/v1/models`](https://inference-docs.cerebras.ai/api-reference/models/public-models).
This request uses public headers only: inference API keys and discovery
credentials are never sent to the metadata endpoint. A custom base URL skips
this public discovery rather than mixing a proxy's catalog with Cerebras metadata.
Without a Cerebras credential, the runtime provider stays inactive. Public
metadata listing does not establish account entitlement.

Live rows supply the native context and completion limits, reasoning and vision
capabilities, and prompt/completion prices. Cerebras returns those prices as USD
per-token strings; OpenClaw converts them to USD per million tokens. The public
feed does not provide a separate cache tariff, so OpenClaw uses the input price
for cache reads, matching Cerebras' standard input billing for cached tokens.

Successful catalogs are cached for 60 seconds. If discovery fails, returns an
empty catalog, or has no usable model rows, OpenClaw uses the bundled offline
seed. In the default `models.mode: "merge"`, fresh onboarding does not copy
generated model rows or prices into your config, allowing prices to refresh.
Explicitly authored model rows and costs remain intact. In
`models.mode: "replace"`, discovery is disabled and onboarding keeps the offline
seed as explicit config instead.

## Built-in catalog

The offline fallback model has a 131,072-token context window and a
40,960-token max output. Its prices were refreshed from the native
[public feed](https://api.cerebras.ai/public/v1/models) on August 31, 2026.

| Model ref               | Name         | Reasoning | Notes                               |
| ----------------------- | ------------ | --------- | ----------------------------------- |
| `cerebras/gpt-oss-120b` | GPT OSS 120B | yes       | Default; production reasoning model |

Fresh onboarding selects GPT OSS 120B. Models retired by Cerebras are not included
in the bundled catalog; existing explicit selections are not rewritten.

## Prompt caching

Cerebras automatically caches matching prompt prefixes. On the native API,
OpenClaw sends a stable `prompt_cache_key` for each conversation to improve cache
routing. Cached tokens reduce prompt processing and uncached-token rate-limit
usage; they are billed at the standard input token price. See
[Cerebras prompt caching](https://inference-docs.cerebras.ai/capabilities/prompt-caching).

## Manual config

Most setups only need the API key. Use explicit `models.providers.cerebras` config to override model metadata in `mode: "merge"`; leave `models` empty to use discovered rows without pinning generated prices:

```json5
{
  env: { vars: { CEREBRAS_API_KEY: "csk-..." } },
  agents: {
    defaults: {
      model: { primary: "cerebras/gpt-oss-120b" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [],
      },
    },
  },
}
```

<Note>
If the Gateway runs as a daemon (launchd, systemd, Docker), make sure `CEREBRAS_API_KEY` is available to that process — for example in `~/.openclaw/.env` or through `env.shellEnv`. A key exported only in an interactive shell will not help a managed service unless the env is imported separately.
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Thinking modes" href="/tools/thinking" icon="brain">
    Reasoning effort levels for the Cerebras models.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Agent defaults and model configuration.
  </Card>
  <Card title="Models FAQ" href="/help/faq-models" icon="circle-question">
    Auth profiles, switching models, and resolving "no profile" errors.
  </Card>
</CardGroup>
