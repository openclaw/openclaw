---
summary: "Use XingChen-AGI's OpenAI-compatible API with OpenClaw"
read_when:
  - You want to run OpenClaw with Xing4.1-Preview models
  - You need the XingChen-AGI provider id, key, or endpoint
title: "XingChen-AGI"
---

XingChen-AGI is the open-source model organization of China Telecom AI
Technology Co., Ltd. It exposes the Xing4.1-Preview model through an
OpenAI-compatible API. In OpenClaw it is a provider plugin: install it once,
store credentials through normal model auth, and use the model ref
`xingchen-agi/xing4.1-preview`.

Use XingChen-AGI when you want direct access to the Xing4.1-Preview reasoning
model through its native API. OpenClaw owns the provider id, auth profile,
model catalog seed, and base URL; XingChen-AGI owns live model availability,
billing, rate limits, and upstream routing.

| Property     | Value                                    |
| ------------ | ---------------------------------------- |
| Provider id  | `xingchen-agi`                           |
| Package      | `@openclaw/xingchen-agi-provider`          |
| Auth env var | `XINGCHEN_API_KEY`                        |
| API          | OpenAI-compatible (`openai-completions`) |
| Base URL     | `https://api-maas.teleai.com.cn/v1`       |
| Default model| `xing4.1-preview`                         |

## Setup

Install the plugin, then create an API key in the China Telecom AI MaaS
dashboard:

```bash
openclaw plugins install @openclaw/xingchen-agi-provider
```

Installation applies to a running Gateway automatically; otherwise it takes
effect on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

Then run:

```bash
openclaw onboard --auth-choice xingchen-agi-api-key
```

For scripted or CI installs, pass everything on the command line:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice xingchen-agi-api-key \
  --xingchen-api-key "$XINGCHEN_API_KEY"
```

Or set the key in the environment instead:

```bash
export XINGCHEN_API_KEY="<your-xingchen-api-key>" # pragma: allowlist secret
```

## When to choose XingChen-AGI

- You want direct access to Xing4.1-Preview through the China Telecom MaaS API.
- You want a Chinese-hosted OpenAI-compatible endpoint.

Choose a local provider such as LM Studio, Ollama, SGLang, or vLLM when data
locality or local GPU control matters more than hosted convenience.

## Models

The plugin catalog seeds the Xing4.1-Preview model:

| Model ref                    | Input | Context | Max output |
| ---------------------------- | ----- | ------- | ---------- |
| `xingchen-agi/xing4.1-preview` | text  | 1,000,000 | 192,000    |

The catalog is a seed, not a promise that every account can call every model at
all times. List what the configured provider reports in your environment:

```bash
openclaw models list --provider xingchen-agi
```

## Troubleshooting

- `401` or `403`: check that `XINGCHEN_API_KEY` is set for the process running
  OpenClaw, or re-run onboarding to store the key in the provider auth profile.
- Unknown model errors: confirm the model exists in your MaaS account and use
  the full `xingchen-agi/xing4.1-preview` ref shown by
  `openclaw models list --provider xingchen-agi`.
- Intermittent provider errors: try a different MaaS model or configure the
  provider as a fallback rather than the only primary model provider.

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)