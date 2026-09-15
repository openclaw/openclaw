---
summary: "Use Prism's long-context models with OpenClaw"
read_when:
  - You want to use Prism as an OpenClaw model provider
  - You need Prism setup or model details
title: "Prism"
---

# Prism

Prism provides OpenAI-compatible inference for coding agents. OpenClaw supports
Prism through the official external `@openclaw/prism-provider` plugin.

| Setting | Value |
| --- | --- |
| Provider | `prism` |
| Authentication | `PRISM_API_KEY` |
| Base URL | `https://api.prisminference.com/v1` |
| API | `openai-completions` |
| Default model | `prism/deepseek-v4.1-flash` |

## Install

```bash
openclaw plugins install @openclaw/prism-provider
openclaw onboard --auth-choice prism-api-key
```

Create an API key in the [Prism dashboard](https://prisminference.com/app/settings/api-keys)
when prompted. OpenClaw stores the key through its native credential flow and
sets `prism/deepseek-v4.1-flash` as the default model.

For non-interactive setup, provide the key through the environment:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice prism-api-key \
  --prism-api-key "$PRISM_API_KEY"
```

## Models

| Model ref | Input | Context | Maximum output |
| --- | --- | ---: | ---: |
| `prism/deepseek-v4.1-flash` | text, image | 1,000,000 | 384,000 |
| `prism/deepseek-v4-flash` | text | 1,000,000 | 384,000 |

List the current plugin catalog:

```bash
openclaw models list --provider prism
```

Prism executes model inference only. OpenClaw continues to run shell, browser,
file, and other tools locally.
