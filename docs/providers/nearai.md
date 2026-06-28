---
summary: "Use NEAR AI Cloud TEE-backed OpenAI-compatible inference in OpenClaw"
read_when:
  - You want NEAR AI Cloud setup guidance
  - You need the NEARAI_API_KEY env var or CLI auth choice
title: "NEAR AI Cloud"
---

NEAR AI Cloud provides an **OpenAI-compatible** inference endpoint with a public model catalog and TEE-backed models. OpenClaw includes a bundled NEAR AI Cloud provider plugin with API-key onboarding, a manifest fallback catalog, and runtime catalog refresh.

| Property        | Value                                    |
| --------------- | ---------------------------------------- |
| Provider id     | `nearai`                                 |
| Auth env var    | `NEARAI_API_KEY`                         |
| Onboarding flag | `--auth-choice nearai-api-key`           |
| Direct CLI flag | `--nearai-api-key <key>`                 |
| API             | OpenAI-compatible (`openai-completions`) |
| Base URL        | `https://cloud-api.near.ai/v1`           |
| Default model   | `nearai/zai-org/GLM-5.1-FP8`             |

## Getting started

<Steps>
  <Step title="Create an API key">
    Create an API key from [NEAR AI Cloud](https://cloud.near.ai).
  </Step>
  <Step title="Run onboarding">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice nearai-api-key
```

```bash Direct flag
openclaw onboard --non-interactive \
  --auth-choice nearai-api-key \
  --nearai-api-key "$NEARAI_API_KEY"
```

```bash Env only
export NEARAI_API_KEY=nai_...
```

    </CodeGroup>

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --all --provider nearai
    ```
  </Step>
</Steps>

## Catalog

The bundled fallback catalog is generated from NEAR AI Cloud's public `GET https://cloud-api.near.ai/v1/model/list` endpoint. When a NEAR AI API key is configured, OpenClaw can refresh the provider catalog at runtime and falls back to the bundled rows if discovery is unavailable.

| Model ref                               | Input       | Context | Max output | Notes                 |
| --------------------------------------- | ----------- | ------- | ---------- | --------------------- |
| `nearai/zai-org/GLM-5.1-FP8`            | text        | 202,752 | 65,536     | Default TEE model     |
| `nearai/Qwen/Qwen3.6-35B-A3B-FP8`       | text        | 262,144 | 65,536     | TEE model             |
| `nearai/Qwen/Qwen3.5-122B-A10B`         | text        | 131,072 | 65,536     | TEE model             |
| `nearai/Qwen/Qwen3-VL-30B-A3B-Instruct` | text, image | 256,000 | 65,536     | TEE vision model      |
| `nearai/openai/gpt-oss-120b`            | text        | 131,000 | 65,536     | TEE open-weight model |
| `nearai/anthropic/claude-opus-4-7`      | text, image | 1M      | 65,536     | External model        |
| `nearai/openai/gpt-5.5`                 | text        | 1.05M   | 65,536     | External model        |

Use `openclaw models list --all --provider nearai` for the current local catalog. NEAR AI Cloud's public catalog marks model-level TEE signals with `metadata.verifiable` and `metadata.attestationSupported`; OpenClaw's model rows keep the OpenAI-compatible execution metadata used by the Gateway.

## Compatibility

NEAR AI Cloud uses standard Bearer-token auth and the OpenAI Chat Completions request shape. OpenClaw configures NEAR AI models with provider compatibility flags that use `max_tokens` and avoid newer OpenAI-only fields such as `store`, developer-role shaping, `reasoning_effort`, and strict structured-output mode.

Model refs keep the full upstream model id after the `nearai/` prefix. For example, `nearai/Qwen/Qwen3.6-35B-A3B-FP8` sends `Qwen/Qwen3.6-35B-A3B-FP8` to NEAR AI Cloud.

## Manual config

The bundled plugin usually means you only need the API key. Use explicit provider config only when you want to override model metadata:

```json5
{
  env: { NEARAI_API_KEY: "nai_..." },
  agents: {
    defaults: {
      model: { primary: "nearai/zai-org/GLM-5.1-FP8" },
    },
  },
  models: {
    providers: {
      nearai: {
        baseUrl: "https://cloud-api.near.ai/v1",
        apiKey: "${NEARAI_API_KEY}",
        api: "openai-completions",
      },
    },
  },
}
```

<Note>
  If the Gateway runs as a daemon or container, make sure `NEARAI_API_KEY` is available to that process. A key exported only in an interactive shell will not help a managed service unless the environment is imported separately.
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Models CLI" href="/cli/models" icon="terminal">
    Listing, setting, and checking provider auth status.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full OpenClaw configuration reference.
  </Card>
  <Card title="NEAR AI Cloud" href="https://cloud.near.ai" icon="arrow-up-right-from-square">
    API keys and account setup.
  </Card>
</CardGroup>
