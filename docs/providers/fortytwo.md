---
summary: "Fortytwo setup for Chat Completions inference"
title: "Fortytwo"
read_when:
  - You want to use Fortytwo in OpenClaw
---

[Fortytwo](https://docs.fortytwo.network/docs/models) provides OpenAI-compatible
Chat Completions. The vendor-maintained
[fortytwo-openclaw](https://github.com/Fortytwo-Network/fortytwo-openclaw)
plugin supplies authentication, live model discovery and inference.

| Property                  | Value                             |
| ------------------------- | --------------------------------- |
| Provider id               | `fortytwo`                        |
| Auth environment variable | `FORTYTWO_API_KEY`                |
| API                       | `openai-completions`              |
| Base URL                  | `https://api.fortytwo.network/v1` |
| Default model             | `fortytwo/qwen/qwen3.8-27b`       |
| Minimum OpenClaw          | `2026.10.9`                       |

## Install and configure

```bash
openclaw plugins install fortytwo
openclaw gateway restart
openclaw onboard --auth-choice fortytwo-api-key
openclaw models list --refresh --provider fortytwo
```

Enter your API key interactively. Existing Gateways need to load the installed
plugin before use. Keep the key out of commands, screenshots and shared config.

## Models and reasoning

Authenticated discovery follows `/v1/models`. Known model IDs retain the plugin's
capability metadata; new chat IDs use conservative defaults. Ordinary onboarding
saves only connection settings. The bundled fallback supports text and image input,
tools, a 262,144-token context and up to 235,929 output tokens.

Select `off`, `low`, `medium` or `xhigh`; `off` sends `reasoning_effort: none`.
For an image probe, use PNG or JPEG. This provider uses Chat Completions only.
See [pricing](https://docs.fortytwo.network/docs/pricing) for current rates.
