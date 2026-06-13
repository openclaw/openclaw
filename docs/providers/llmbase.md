---
summary: "Configure LLMBase's OpenAI-compatible agent API in OpenClaw"
title: "LLMBase"
read_when:
  - You want to use LLMBase with OpenClaw
  - You need the LLMBase agent API base URL or key type
  - You want a sovereign open-source model platform for agent workflows
---

[LLMBase](https://llmbase.ai) is a privacy-focused, sovereign AI platform for
hosted open-source models. Its OpenAI-compatible agent API lets OpenClaw use
LLMBase models without running your own inference stack.

Use LLMBase when you want OpenClaw backed by curated open-source models,
managed routing, and subscription-backed agent access for coding agents,
research assistants, local developer tools, or self-hosted assistants.

| Property                | Value                                    |
| ----------------------- | ---------------------------------------- |
| Provider id             | `llmbase`                                |
| API                     | OpenAI-compatible (`openai-completions`) |
| Agent base URL          | `https://llmbase.ai/api/v1/agents`       |
| Agent key env var       | `LLMBASE_CHAT_AGENT_KEY`                 |
| Agent key prefix        | `llmbase_chat_...`                       |
| Suggested default model | `llmbase/deepseek/deepseek-v4-flash`     |
| Direct inference API    | `https://api.llmbase.ai/v1`              |
| Direct API key prefix   | `llmbase_...`                            |

## Why LLMBase in OpenClaw

- Sovereign AI platform built for privacy-conscious workflows.
- Hosted open-source models without maintaining vLLM, SGLang, Ollama, or LM
  Studio.
- OpenAI-compatible chat, streaming, tool calling, structured outputs, and
  model discovery.
- Managed model routing behind stable LLMBase model IDs.
- Agent access on the LLMBase Pro plan, currently $19/month.

LLMBase separates chat-agent subscription access from direct inference billing.
Use a `llmbase_chat_...` key with OpenClaw. Use a `llmbase_...` inference key
only for backend services, batch jobs, or product integrations that need direct
token-based billing.

## Getting started

<Steps>
  <Step title="Create a chat agent key">
    1. Open [llmbase.ai](https://llmbase.ai).
    2. Go to Dashboard -> API Keys.
    3. Create a key under **Chat agent keys**.
    4. Copy the `llmbase_chat_...` key immediately.

    Free and Starter accounts cannot create or use chat agent keys. Agent
    access requires the LLMBase Pro plan.

  </Step>
  <Step title="Configure LLMBase as a custom provider">
    Add LLMBase under `models.providers` and set your primary model to the
    matching `llmbase/...` model ref:

```json5
{
  models: {
    mode: "merge",
    providers: {
      llmbase: {
        baseUrl: "https://llmbase.ai/api/v1/agents",
        apiKey: "${LLMBASE_CHAT_AGENT_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "deepseek/deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            reasoning: true,
            input: ["text"],
            contextWindow: 1048576,
            maxTokens: 32768,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "llmbase/deepseek/deepseek-v4-flash" },
    },
  },
}
```

    `apiKey: "${LLMBASE_CHAT_AGENT_KEY}"` tells OpenClaw to read the key from
    the Gateway process environment. Keep the real `llmbase_chat_...` value out
    of committed config.

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider llmbase
    ```

    You can also verify the live LLMBase agent model endpoint directly:

    ```bash
    curl https://llmbase.ai/api/v1/agents/models \
      -H "Authorization: Bearer $LLMBASE_CHAT_AGENT_KEY"
    ```

  </Step>
</Steps>

## Model references

OpenClaw model refs use the `llmbase/` provider prefix followed by the stable
LLMBase model ID:

| Model ref                            | Best fit                              |
| ------------------------------------ | ------------------------------------- |
| `llmbase/deepseek/deepseek-v4-flash` | Default agent model                   |
| `llmbase/z-ai/glm-5.1`               | Coding and agent orchestration        |
| `llmbase/qwen/qwen3-coder`           | Repository work and structured coding |
| `llmbase/deepseek/deepseek-v3.2`     | Reasoning-heavy workflows             |
| `llmbase/deepseek/deepseek-v4-pro`   | Long-context flagship tasks           |
| `llmbase/openai/gpt-oss-120b`        | Open-weight reasoning                 |

For most OpenClaw users, start with `llmbase/deepseek/deepseek-v4-flash`.
Switch to `llmbase/z-ai/glm-5.1` or `llmbase/qwen/qwen3-coder` for code-heavy
workflows, and reserve larger models for difficult long-context tasks.

Add any additional model returned by LLMBase to `models.providers.llmbase.models`
with its provider-local `id`. Do not include the `llmbase/` prefix inside the
model entry itself.

<AccordionGroup>
  <Accordion title="How model id prefixing works">
    Every LLMBase model ref in OpenClaw starts with `llmbase/`. OpenClaw uses
    the prefix to select the configured custom provider, then sends the
    remaining model ID to the LLMBase OpenAI-compatible API.

    For example:

    - OpenClaw model ref: `llmbase/deepseek/deepseek-v4-flash`
    - LLMBase API model field: `deepseek/deepseek-v4-flash`

    Agents do not configure upstream provider routes or fallback graphs.
    LLMBase handles eligible routing internally while preserving the public
    model ID in OpenClaw config.

  </Accordion>
  <Accordion title="Agent plan and quotas">
    LLMBase agent access is available on the LLMBase Pro plan, currently
    $19/month. Agent requests consume the same included chat usage pool as
    normal LLMBase Chat requests, with fair-use windows by model class.

    Optional prepaid overflow can continue agent traffic after a Pro quota
    window is exhausted. Production jobs, unattended background workers, and
    customer-facing API products should use the direct inference API instead.

  </Accordion>
  <Accordion title="Environment availability for the daemon">
    If the Gateway runs as a managed service through launchd, systemd, Docker,
    or a remote host, `LLMBASE_CHAT_AGENT_KEY` must be visible to that process.

    <Warning>
      A key exported only in an interactive shell will not help a launchd or
      systemd daemon unless that environment is imported there too. Set the key
      in `~/.openclaw/.env` or via `env.shellEnv` to make it readable from the
      Gateway process.
    </Warning>

    On macOS, `openclaw gateway install` wires `~/.openclaw/.env` into the
    LaunchAgent environment file. Re-run install or `openclaw doctor --fix`
    after rotating the key.

  </Accordion>
</AccordionGroup>

## Troubleshooting

- `401 invalid_api_key`: use a `llmbase_chat_...` chat agent key, not an
  inference key, OpenAI key, or another provider key.
- `403 chat_pro_required`: upgrade to LLMBase Pro before creating or using chat
  agent keys.
- `402 quota_exceeded`: the Pro agent quota window is exhausted. Wait for the
  reset, switch to a smaller eligible model, or enable prepaid overflow in
  LLMBase.
- Unknown model errors: list models from
  `https://llmbase.ai/api/v1/agents/models` and add the provider-local model ID
  under `models.providers.llmbase.models`.
- Direct inference key confusion: `llmbase_...` keys belong to
  `https://api.llmbase.ai/v1`; OpenClaw agent access uses `llmbase_chat_...`
  keys with `https://llmbase.ai/api/v1/agents`.

## Related

<CardGroup cols={2}>
  <Card title="LLMBase" href="https://llmbase.ai" icon="external-link">
    Privacy-focused sovereign AI platform for hosted open-source models.
  </Card>
  <Card title="LLMBase agent integrations" href="https://llmbase.ai/docs/agents/" icon="bot">
    LLMBase setup details for OpenClaw, Hermes, and other agents.
  </Card>
  <Card title="Custom providers" href="/gateway/config-tools#custom-providers-and-base-urls" icon="settings">
    OpenClaw config reference for custom OpenAI-compatible providers.
  </Card>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
</CardGroup>
