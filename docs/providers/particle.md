---
summary: "Use Particle-1 with an API key in OpenClaw"
title: "Particle"
read_when:
  - You want to use Particle-1 with OpenClaw
  - You need Particle authentication or reasoning settings
---

[Particle](https://particle.ai) serves Particle-1 through an OpenAI-compatible
Chat Completions API.

| Property                     | Value                             |
| ---------------------------- | --------------------------------- |
| Provider                     | `particle`                        |
| Plugin                       | `@openclaw/particle-provider`     |
| API key environment variable | `PARTICLE_API_KEY`                |
| Base URL                     | `https://api.particle.ai/v1`      |
| API                          | `openai-completions`              |
| Default model                | `particle/particle-ai/particle-1` |

## Setup

1. Create an API key at [platform.particle.ai](https://platform.particle.ai).
   Inference requires the key's `inference` scope and a positive credit balance
   unless Particle grants the key free access.
2. Install the provider plugin:

   ```bash
   openclaw plugins install @openclaw/particle-provider
   ```

3. Run onboarding:

   ```bash
   openclaw onboard --auth-choice particle-api-key
   ```

For non-interactive setup with a key already in the environment:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice particle-api-key \
  --particle-api-key "$PARTICLE_API_KEY"
```

Make the environment variable available to the Gateway process, not just your
interactive shell. See [Environment variables](/help/environment).

Verify configuration and select the model:

```bash
openclaw models list --provider particle
openclaw models set particle/particle-ai/particle-1
```

## Particle-1

The catalog uses the ID Particle lists and returns, `particle-ai/particle-1`. The short
alias `particle-1` is accepted wherever you type a model.

- Text and image input; text output, reasoning, and function tool calling.
- 1,048,576-token context window; up to 131,072 output tokens. Particle defaults
  to 32,000 output tokens when a client does not send a limit; OpenClaw sends
  its own output limit.
- Standard prices: $0.25 input, $0.03 cached input, and $1.00 output per million
  tokens. Reasoning tokens count as output tokens. These are catalog estimates,
  not a live billing report.

Limits and prices were checked against Particle's
[model catalog](https://docs.particle.ai/models) and
[billing documentation](https://docs.particle.ai/usage-billing) on October 29, 2026.

## Reasoning and caching

Particle-1 defaults to high reasoning. OpenClaw exposes `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, and `max`:

- `off` sends `reasoning_effort: "none"`.
- `minimal` and `low` select low effort.
- `medium`, `high`, and `xhigh` select high effort.
- `max` selects max effort.

See [Thinking levels](/tools/thinking) and Particle's
[reasoning controls](https://docs.particle.ai/reasoning).

The plugin enables the standard conversation `prompt_cache_key` for cache
routing. Particle does not document a client-selectable cache-retention duration.

## Supported API surface

This integration uses HTTP Chat Completions with SSE streaming. After you sign
in, the model picker lists every chat model your Particle account lists (for
example `deepseek-ai/deepseek-v41-flash-1017` and `z-ai/glm-5.3-flash`); the
curated limits, prices and thinking controls on this page are for Particle-1.
It does not integrate Particle's separate Responses WebSocket API, mid-turn
steering, file uploads or hosted web search.

Particle accepts JSON mode, but does **not** advertise schema-guaranteed
structured output. Do not rely on strict JSON Schema enforcement.

Official references: [Quickstart](https://docs.particle.ai/quickstart),
[Authentication](https://docs.particle.ai/authentication),
[Chat Completions](https://docs.particle.ai/chat-completions).
