---
summary: "Eden AI setup (auth + model selection)"
title: "Eden AI"
read_when:
  - You want to use Eden AI with OpenClaw
  - You need to authenticate Eden AI through one key and route to many vendors
  - You want to know which Eden AI model id to pick
---

[Eden AI](https://www.edenai.co) is a European AI orchestration platform that routes to all the best model vendors (OpenAI, Anthropic, Google, Mistral, Cohere, and more) through one OpenAI-compatible API. Prompts and outputs are not stored by default ([details](https://www.edenai.co/data-compliancy)). OpenClaw includes a bundled Eden AI provider plugin.

| Property        | Value                                    |
| --------------- | ---------------------------------------- |
| Provider id     | `edenai`                                 |
| Plugin          | bundled, `enabledByDefault: true`        |
| Auth env var    | `EDENAI_API_KEY`                         |
| Onboarding flag | `--auth-choice edenai-api-key`           |
| Direct CLI flag | `--edenai-api-key <key>`                 |
| Aliases         | `eden`, `eden-ai`, `eden_ai`             |
| API             | OpenAI-compatible (`openai-completions`) |
| Base URL        | `https://api.edenai.run/v3`              |
| Default model   | `edenai/anthropic/claude-sonnet-4-6`     |

## When to use Eden AI

- You want one API key and unified billing across many vendors without rewriting code per provider.
- You need an EU-hosted orchestration layer with documented data-handling commitments.
- You want [BYOK](https://www.edenai.co/docs/v3/general/byok) so existing vendor agreements and credits keep applying through the same transport.

## Get an API key

Sign in to the [Eden AI dashboard](https://app.edenai.run/settings/api-keys) and copy your key.

## Set the key

OpenClaw reads `EDENAI_API_KEY` from several sources, in precedence order: shell env, `./.env`, `~/.openclaw/.env`, then the `env` block of `~/.openclaw/openclaw.json`. Pick whichever fits your setup.

<CodeGroup>

```bash .env file (recommended for local dev)
# At the repo root, copy .env.example to .env and fill in:
EDENAI_API_KEY=ek_...
```

```bash ~/.openclaw/.env (recommended for daemons)
# For launchd / systemd / Docker, drop the key here so the daemon process picks it up:
EDENAI_API_KEY=ek_...
```

```bash Shell export
export EDENAI_API_KEY=ek_...
```

</CodeGroup>

## Onboard

<CodeGroup>

```bash Onboarding wizard
openclaw onboard --auth-choice edenai-api-key
```

```bash Non-interactive (local, no Gateway daemon)
openclaw onboard --non-interactive --accept-risk --mode local --skip-health \
  --auth-choice edenai-api-key \
  --edenai-api-key "$EDENAI_API_KEY"
```

```bash Non-interactive (with Gateway daemon)
openclaw onboard --non-interactive --accept-risk --install-daemon \
  --auth-choice edenai-api-key \
  --edenai-api-key "$EDENAI_API_KEY"
```

</CodeGroup>

## Pick a model

Any Eden AI model id works as `edenai/<vendor>/<model>`. Set the default in `~/.openclaw/openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "edenai/anthropic/claude-sonnet-4-6" },
    },
  },
}
```

Or switch interactively from the TUI:

```text
/model edenai/openai/gpt-5.5
```

Browse the full Eden AI catalog at [app.edenai.run/models](https://app.edenai.run/models) to find the exact id for the model you want.

## Bundled offline catalog

When `EDENAI_API_KEY` is not set, OpenClaw shows this curated list. Once your key is configured, the live `/v3/models` catalog supersedes it.

| Model ref                             | Name                  | Context |
| ------------------------------------- | --------------------- | ------- |
| `edenai/anthropic/claude-opus-4-7`    | Claude Opus 4.7       | 1M      |
| `edenai/anthropic/claude-sonnet-4-6`  | Claude Sonnet 4.6     | 1M      |
| `edenai/anthropic/claude-haiku-4-5`   | Claude Haiku 4.5      | 200K    |
| `edenai/openai/gpt-5.5`               | GPT-5.5               | 400K    |
| `edenai/openai/gpt-4o-mini`           | GPT-4o mini           | 128K    |
| `edenai/google/gemini-3.5-flash`      | Gemini 3.5 Flash      | 1M      |
| `edenai/google/gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | 1M      |
| `edenai/mistral/mistral-large-latest` | Mistral Large         | 128K    |

<Warning>
  Anthropic model ids on Eden AI use the hyphen form (`claude-opus-4-7`), not the dot form (`claude-opus-4.7`). Eden AI returns HTTP 400 on the dot form.
</Warning>

## Beyond text inference

Eden AI also exposes image generation, video generation, OCR and document parsing, speech-to-text, text-to-speech, translation, content moderation, deepfake detection, AI-content detection, image and PII anonymization, face detection and recognition, and embeddings. The OpenClaw plugin currently registers text inference only - the other capabilities will land as follow-up PRs once the matching OpenClaw provider contracts are wired up.

## Use it

```bash
openclaw chat --local --message "Reply with exactly OK."
```

## Troubleshooting

If a chat request errors with `provider rejected the request schema or tool payload`, two common causes:

1. **Stale session transcript from a previously failed model.** Reset the active session through a supported flow:
   - Inside the TUI: type `/reset` and press Enter.
   - From the CLI: `openclaw sessions cleanup`.

2. **Model id does not exist in Eden AI's catalog.** Eden AI does not accept Anthropic's date-suffixed ids (e.g. `claude-3-5-sonnet-20241022`). Browse [app.edenai.run/models](https://app.edenai.run/models) for the exact id Eden AI uses (typically without the date suffix), then set it as the primary model:

   ```bash
   jq --arg id "edenai/<eden-ai-id>" \
     '.agents.defaults.model.primary = $id |
      .agents.defaults.models[$id] = {"alias": "Eden AI"}' \
     ~/.openclaw/openclaw.json > /tmp/c.json && mv /tmp/c.json ~/.openclaw/openclaw.json
   ```

## More

- [Eden AI API documentation](https://www.edenai.co/docs) - the authoritative reference for every endpoint, parameter, and underlying-vendor option behind Eden AI
- [Eden AI's OpenClaw integration guide](https://www.edenai.co/docs/v3/integrations/openclaw)
- [Eden AI data handling](https://www.edenai.co/data-compliancy)
- [Eden AI model catalog](https://app.edenai.run/models)
- [Get an API key](https://app.edenai.run/settings/api-keys)

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Agent defaults and model configuration.
  </Card>
  <Card title="Models FAQ" href="/help/faq-models" icon="circle-question">
    Auth profiles, switching models, and resolving "no profile" errors.
  </Card>
  <Card title="Building plugins" href="/plugins/sdk-provider-plugins" icon="puzzle">
    Provider plugin SDK if you want to write your own.
  </Card>
</CardGroup>
