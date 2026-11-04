---
summary: "Use Scaleway's OpenAI-compatible Generative APIs with OpenClaw"
read_when:
  - You want to run OpenClaw with Scaleway Generative APIs models
  - You need the Scaleway provider id, key, or endpoint
title: "Scaleway"
---

Scaleway Generative APIs is a fully managed inference service hosting frontier
and open-weight models from European data centers, behind an OpenAI-compatible
API. In OpenClaw it is an official provider plugin: store credentials through
normal model auth, and use model refs like `scaleway/glm-5.3`.

Use Scaleway when you want EU-hosted inference for open-weight model families —
Qwen, GLM, DeepSeek, Gemma, GPT-OSS, Llama, and Mistral — under one API key and
one account. OpenClaw owns the provider id, auth profile, model catalog seed,
and base URL; Scaleway owns live model availability, billing, rate limits, and
any provider-side routing policy.

| Property      | Value                                    |
| ------------- | ---------------------------------------- |
| Provider id   | `scaleway`                               |
| Package       | `@openclaw/scaleway-provider`            |
| Auth env var  | `SCW_SECRET_KEY`                         |
| API           | OpenAI-compatible (`openai-completions`) |
| Base URL      | `https://api.scaleway.ai/v1`             |
| Default model | `scaleway/glm-5.3`                       |

## Setup

The plugin is bundled and enabled by default. Create an IAM API key in the
[Scaleway console](https://www.scaleway.com/en/docs/iam/credentials/create-api-keys/),
then run:

```bash
openclaw onboard --auth-choice scaleway-api-key
```

For scripted or CI installs, pass everything on the command line:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice scaleway-api-key \
  --scaleway-api-key "$SCW_SECRET_KEY"
```

Or set the key in the environment instead:

```bash
export SCW_SECRET_KEY="<your-scaleway-secret-key>" # pragma: allowlist secret
```

By default, requests run on your Scaleway default Project. To run them on a
specific Project (for example, to track billing separately), set the provider
base URL to `https://api.scaleway.ai/<project-id>/v1` in
`models.providers.scaleway` configuration.

## When to choose Scaleway

- You want hosted inference with EU data residency rather than a local model
  server.
- You want open-weight frontier models (Qwen3.5, GLM-5.3, DeepSeek V4, Mistral
  Medium 3.5) through one provider account.
- You want a fallback provider with different upstream hosting from OpenRouter,
  Together, or the direct vendor APIs.
- You need Scaleway-specific model ids, pricing, or account controls.

Choose a direct vendor provider instead when you need vendor-native features
that Scaleway does not expose through its OpenAI-compatible route. Choose a
local provider such as LM Studio, Ollama, SGLang, or vLLM when local GPU
control matters more than hosted convenience; Scaleway also offers dedicated
Generative APIs deployments you can point at with an explicit base URL.

## Models

The plugin lists the models your account can call live from
`https://api.scaleway.ai/v1`, so new Scaleway models appear without an
OpenClaw upgrade. The catalog seeds commonly available Serverless route ids:

| Model ref                           | Input              | Context | Max output |
| ----------------------------------- | ------------------ | ------- | ---------- |
| `scaleway/glm-5.3`                  | text               | 256,000 | 16,384     |
| `scaleway/deepseek-v4.1-flash-1017` | text + image       | 256,000 | 32,768     |
| `scaleway/qwen3.8-27b`              | text + image       | 262,144 | 32,768     |
| `scaleway/qwen3.5-397b-a17b`        | text, image, video | 256,000 | 16,384     |
| `scaleway/gemma-4-26b-a4b-it`       | text + image       | 256,000 | 32,768     |
| `scaleway/gpt-oss-120b`             | text               | 128,000 | 32,768     |
| `scaleway/mistral-medium-3.5-128b`  | text + image       | 180,000 | 16,384     |

List what the configured provider reports in your environment:

```bash
openclaw models list --provider scaleway
```

## Troubleshooting

- `401` or `403`: check that `SCW_SECRET_KEY` is set for the process running
  OpenClaw, or re-run onboarding to store the key in the provider auth profile.
- Unknown model errors: confirm the model exists in your Scaleway account and
  use the full `scaleway/<model-id>` ref shown by
  `openclaw models list --provider scaleway`.
- Project routing errors: verify the Project id in a custom
  `https://api.scaleway.ai/<project-id>/v1` base URL matches a Project your API
  key can access.

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
