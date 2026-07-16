---
summary: "LLMRouter setup (auth + auto model routing)"
title: "LLMRouter"
read_when:
  - You want to use LLMRouter with OpenClaw
  - You want requests routed to the cheapest model that meets the query's needs
---

[LLMRouter](https://llmrouter.sh) is an OpenAI-compatible routing API. Requests sent with
`model:"auto"` are routed to the cheapest model that meets the query's needs, balancing quality,
cost, and latency; requests can also pin a specific upstream model by slug.

| Property        | Value                                                      |
| --------------- | ---------------------------------------------------------- |
| Provider id     | `llmrouter`                                                |
| Plugin          | official external package (`@openclaw/llmrouter-provider`) |
| Auth env var    | `LLMROUTER_API_KEY`                                        |
| Onboarding flag | `--auth-choice llmrouter-api-key`                          |
| Direct CLI flag | `--llmrouter-api-key <key>`                                |
| API             | OpenAI-compatible (`openai-completions`)                   |
| Base URL        | `https://api.llmrouter.sh/v1`                              |
| Default model   | `llmrouter/auto`                                           |

## Install plugin

```bash
openclaw plugins install @openclaw/llmrouter-provider
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an API key at [llmrouter.sh/keys](https://llmrouter.sh/keys) (`llmr_sk_...`).
  </Step>
  <Step title="Run onboarding">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice llmrouter-api-key
```

```bash Direct flag
openclaw onboard --non-interactive \
  --auth-choice llmrouter-api-key \
  --llmrouter-api-key "$LLMROUTER_API_KEY"
```

```bash Env only
export LLMROUTER_API_KEY=...
```

    </CodeGroup>

    Prompts for your API key and sets `llmrouter/auto` as the default model.

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider llmrouter
    ```
  </Step>
</Steps>

## Auto routing

`llmrouter/auto` is the default model and LLMRouter's headline feature: every request is
classified for difficulty, task type, and required capabilities (reasoning, code, tools, vision,
long context), then routed to the cheapest model in LLMRouter's registry that satisfies those
requirements.

```json5
{
  agents: {
    defaults: {
      model: { primary: "llmrouter/auto" },
    },
  },
}
```

Response headers from LLMRouter expose the routing decision (`x-llmrouter-model`,
`x-llmrouter-reason`, `x-llmrouter-cost-usd`, and related fields); see the
[LLMRouter README](https://llmrouter.sh) for the full list.

## Pinning a specific model

Any model slug other than `auto` pins that upstream model directly instead of routing. LLMRouter
exposes 500+ bare slugs (`GET /v1/models`, no provider prefix) spanning OpenAI, Anthropic, Gemini,
DeepSeek, and other families; pass any of them straight through as `llmrouter/<slug>`, no config
changes required. For example:

| Family    | Example slug      | Model ref                   |
| --------- | ----------------- | --------------------------- |
| OpenAI    | `gpt-5.4`         | `llmrouter/gpt-5.4`         |
| Anthropic | `claude-opus-4.6` | `llmrouter/claude-opus-4.6` |
| Google    | `gemini-2.5-pro`  | `llmrouter/gemini-2.5-pro`  |
| DeepSeek  | `deepseek-r1`     | `llmrouter/deepseek-r1`     |

```json5
{
  agents: {
    defaults: {
      model: { primary: "llmrouter/claude-opus-4.6" },
    },
  },
}
```

Use `/model llmrouter/<slug>` to switch an existing chat. Pinned models resolve with generic
capability defaults (OpenClaw does not know a pinned slug's true context window or per-token cost
ahead of time); LLMRouter's own response still reports the real cost for billing.

<Note>
If Gateway runs as a daemon (launchd/systemd), make sure `LLMROUTER_API_KEY` is available to that
process (for example, in `~/.openclaw/.env` or via `env.shellEnv`).
</Note>

## Config example

```json5
{
  env: { LLMROUTER_API_KEY: "llmr_sk_..." },
  agents: {
    defaults: {
      model: { primary: "llmrouter/auto" },
    },
  },
}
```

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="OpenRouter" href="/providers/openrouter" icon="route">
    Another aggregator provider with a similar `auto` routing model.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
