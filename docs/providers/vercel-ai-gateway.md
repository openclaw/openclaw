---
summary: "Vercel AI Gateway setup (auth + model selection)"
title: "Vercel AI gateway"
read_when:
  - You want to use Vercel AI Gateway with OpenClaw
  - You need the API key env var or CLI auth choice
---

The [Vercel AI Gateway](https://vercel.com/ai-gateway) provides a unified API to
access hundreds of models through a single endpoint.

| Property      | Value                                  |
| ------------- | -------------------------------------- |
| Provider      | `vercel-ai-gateway`                    |
| Package       | `@openclaw/vercel-ai-gateway-provider` |
| Auth          | `AI_GATEWAY_API_KEY`                   |
| API           | Anthropic Messages compatible          |
| Base URL      | `https://ai-gateway.vercel.sh`         |
| Model catalog | Auto-discovered via `/v1/models`       |

<Tip>
OpenClaw auto-discovers the Gateway `/v1/models` catalog, so both the
`/models vercel-ai-gateway` chat command and
`openclaw models list --provider vercel-ai-gateway` include current model
refs such as `vercel-ai-gateway/openai/gpt-5.5` and
`vercel-ai-gateway/moonshotai/kimi-k2.6`.
</Tip>

## Getting started

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/vercel-ai-gateway-provider
    ```

    Installation applies to a running Gateway automatically; otherwise it takes effect
    on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

  </Step>
  <Step title="Set the API key">
    ```bash
    openclaw onboard --auth-choice ai-gateway-api-key
    ```
  </Step>
  <Step title="Set a default model">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
        },
      },
    }
    ```
  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider vercel-ai-gateway
    ```
  </Step>
</Steps>

## Non-interactive example

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Model ID shorthand

OpenClaw normalizes Claude shorthand model refs at runtime:

| Shorthand input                     | Normalized model ref                          |
| ----------------------------------- | --------------------------------------------- |
| `vercel-ai-gateway/claude-opus-4.6` | `vercel-ai-gateway/anthropic/claude-opus-4.6` |
| `vercel-ai-gateway/opus-4.6`        | `vercel-ai-gateway/anthropic/claude-opus-4-6` |

<Tip>
Use either form in your configuration; OpenClaw resolves the canonical
`anthropic/...` ref automatically.
</Tip>

## Decision models

The plugin also serves TypeSafe AI's Jev through the Gateway for the separate
[decision model](/concepts/decision-models) role:

| Model reference                            | Model      |
| ------------------------------------------ | ---------- |
| `vercel-ai-gateway/typesafe-ai/jev`        | Jev        |
| `vercel-ai-gateway/typesafe-ai/jev-1.13.0` | Jev 1.13.0 |

Decision evaluation does not use the key that onboarding stores for chat
models. It reads only the SecretRef at
`plugins.entries.vercel-ai-gateway.config.apiKey`. After chat onboarding alone,
the Decision models are listed but every evaluation returns
`credentials-unavailable`. Also set `enabled: true` on the plugin entry: when
the plugin is bundled with OpenClaw, this credential stays inactive until the
entry is explicitly enabled.

To reuse the same Gateway key, merge this into your configuration. It
references `AI_GATEWAY_API_KEY` from the plugin entry and selects a decision
model. To use a protected credential created in Settings → Secrets instead,
reference it with a `store` ref.

```json5
{
  plugins: {
    entries: {
      "vercel-ai-gateway": {
        enabled: true,
        config: {
          apiKey: { source: "env", provider: "default", id: "AI_GATEWAY_API_KEY" },
        },
      },
    },
  },
  agents: {
    defaults: { decisionModel: "vercel-ai-gateway/typesafe-ai/jev" },
  },
}
```

The environment variable must be visible to the Gateway process, as described
under [Advanced configuration](#advanced-configuration). Evaluations send the
selected evidence through Vercel AI Gateway and incur its normal usage charges.

The Gateway answers evidence beyond the model's input limit with HTTP 503, the
same status it uses for a service outage, so OpenClaw counts it as a transport
failure. After three consecutive transport failures, evaluations through this
provider pause for at least 10 seconds; callers keep their normal behavior
while it is paused. Keep evaluation evidence well within the model's input
limit. Boolean questions also need non-empty `instructions`: the Gateway
rejects them otherwise, and the evaluation returns `unsupported-input`.

## Advanced configuration

<AccordionGroup>
  <Accordion title="Environment variable for daemon processes">
    If the OpenClaw Gateway runs as a daemon (launchd/systemd), make sure
    `AI_GATEWAY_API_KEY` is available to that process.

    <Warning>
    A key exported only in an interactive shell will not be visible to a
    launchd/systemd daemon unless that environment is explicitly imported. Set
    the key in `~/.openclaw/.env` or via `env.shellEnv` to ensure the gateway
    process can read it.
    </Warning>

  </Accordion>

  <Accordion title="Provider routing">
    Vercel AI Gateway routes each request to the upstream provider named in the
    model ref prefix. For example, `vercel-ai-gateway/anthropic/claude-opus-4.6`
    routes through Anthropic, `vercel-ai-gateway/openai/gpt-5.5` routes through
    OpenAI, and `vercel-ai-gateway/moonshotai/kimi-k2.6` routes through
    MoonshotAI. One `AI_GATEWAY_API_KEY` authenticates all upstream providers.
  </Accordion>
  <Accordion title="Thinking levels">
    `/think` options follow the upstream model prefix when OpenClaw recognizes
    it. `vercel-ai-gateway/anthropic/...` uses the Claude thinking profile,
    including the adaptive default for Claude 4.6 models. Trusted
    `vercel-ai-gateway/openai/...` refs (`gpt-5.2` and newer, plus Codex
    variants down to `gpt-5.1-codex`) expose `/think xhigh`. Other namespaced
    refs keep the standard reasoning levels unless their catalog metadata
    declares more.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    General troubleshooting and FAQ.
  </Card>
</CardGroup>
