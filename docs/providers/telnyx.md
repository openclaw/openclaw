---
summary: "Telnyx setup for OpenAI-compatible AI inference"
title: "Telnyx"
read_when:
  - You want to run Telnyx-hosted models in OpenClaw
  - You want one OpenAI-compatible API for Telnyx AI inference
---

[Telnyx AI inference](https://developers.telnyx.com/docs/inference/getting-started) provides hosted, OpenAI-compatible access to open-weight models plus proxied frontier routes. The official external plugin uses authenticated discovery, so OpenClaw follows the complete model set enabled for your Telnyx account. Its offline fallback contains the models available when this OpenClaw release was built.

| Property        | Value                                                   |
| --------------- | ------------------------------------------------------- |
| Provider id     | `telnyx`                                                |
| Plugin          | official external package (`@openclaw/telnyx-provider`) |
| Auth env var    | `TELNYX_API_KEY`                                        |
| Onboarding flag | `--auth-choice telnyx-api-key`                          |
| Direct CLI flag | `--telnyx-api-key <key>`                                |
| API             | OpenAI-compatible (`openai-completions`)                |
| Base URL        | `https://api.telnyx.com/v2/ai/openai`                   |
| Default model   | `telnyx/moonshotai/Kimi-K2.6`                           |

## Install plugin

```bash
openclaw plugins install @openclaw/telnyx-provider
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Create a Telnyx account and API key">
    Create a key in the [Telnyx API keys portal](https://portal.telnyx.com/#/app/api-keys). Inference calls are usage-priced; see the [Telnyx inference docs](https://developers.telnyx.com/docs/inference/getting-started) for current models and rates.
  </Step>
  <Step title="Run onboarding">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice telnyx-api-key
```

```bash Direct flag
openclaw onboard --non-interactive \
  --auth-choice telnyx-api-key \
  --telnyx-api-key "$TELNYX_API_KEY"
```

```bash Env only
export TELNYX_API_KEY=...
```

    </CodeGroup>

    In an interactive run, pick the **Telnyx API key** choice.

  </Step>
  <Step title="Verify the live catalog">
    ```bash
    openclaw models list --provider telnyx
    ```

    With usable auth, the plugin requests the authenticated `/models` endpoint and lists every model returned for the account. Without auth, it stays offline and uses the bundled fallback.

  </Step>
</Steps>

## Default model

`telnyx/moonshotai/Kimi-K2.6` is the default model. In OpenClaw it supports text and image input, tool calling, reasoning, and a 262k-token context window:

```json5
{
  agents: {
    defaults: {
      model: { primary: "telnyx/moonshotai/Kimi-K2.6" },
    },
  },
}
```

Use `/model telnyx/moonshotai/Kimi-K2.6` to switch an existing chat.

## Live model discovery

The plugin fetches the authenticated `/models` endpoint and caches the result for five minutes, then merges those rows over the bundled catalog. Newly launched Telnyx models appear automatically without an OpenClaw release, including proxied frontier routes such as `telnyx/openai/gpt-5.x`, `telnyx/anthropic/claude-haiku-4-5`, and `telnyx/google/gemini-2.5-flash`.

## Bundled fallback catalog

The authenticated live catalog is authoritative. These rows keep setup and model selection useful before discovery succeeds:

| Model ref                                  | Input       | Context | Max output |
| ------------------------------------------ | ----------- | ------: | ---------: |
| `telnyx/moonshotai/Kimi-K2.6`              | text, image |    262k |         8k |
| `telnyx/moonshotai/Kimi-K3`                | text, image |      1M |        64k |
| `telnyx/moonshotai/Kimi-K2.5`              | text, image |    256k |         8k |
| `telnyx/zai-org/GLM-5.2`                   | text        |      1M |       131k |
| `telnyx/zai-org/GLM-5.1-FP8`               | text        |    202k |         8k |
| `telnyx/MiniMaxAI/MiniMax-M3-MXFP8`        | text        |      1M |         8k |
| `telnyx/MiniMaxAI/MiniMax-M2.7`            | text        |    200k |         8k |
| `telnyx/Qwen/Qwen3-235B-A22B`              | text        |     32k |         8k |
| `telnyx/meta-llama/Llama-3.3-70B-Instruct` | text        |     99k |         8k |

All bundled models support tool calling, and all except `telnyx/meta-llama/Llama-3.3-70B-Instruct` support reasoning. Streaming usage is reported on the final chunk.

<Note>
Telnyx can add, remove, or change hosted models independently of OpenClaw releases. The plugin refreshes model ids, context limits, output limits, and pricing from the authenticated API while retaining model-specific OpenClaw transport policy.
</Note>

## Manual config

Most setups only need the API key. To pin the provider explicitly:

```json5
{
  env: { TELNYX_API_KEY: "..." },
  agents: {
    defaults: {
      model: { primary: "telnyx/moonshotai/Kimi-K2.6" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      telnyx: {
        baseUrl: "https://api.telnyx.com/v2/ai/openai",
        apiKey: "${TELNYX_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "moonshotai/Kimi-K2.6",
            name: "Kimi K2.6",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

<Note>
If the Gateway runs as a daemon (launchd, systemd, Docker), make sure `TELNYX_API_KEY` is available to that process. A key exported only in an interactive shell is not visible to an already-running managed service.
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Thinking modes" href="/tools/thinking" icon="brain">
    Select OpenClaw reasoning effort levels.
  </Card>
  <Card title="Models CLI" href="/cli/models" icon="terminal">
    List, inspect, and select discovered models.
  </Card>
  <Card title="Models FAQ" href="/help/faq-models" icon="circle-question">
    Auth profiles and model-selection troubleshooting.
  </Card>
</CardGroup>
