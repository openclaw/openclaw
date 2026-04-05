---
summary: "Use OpenRouter's unified API to access many models in Mullusi"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via OpenRouter in Mullusi
title: "OpenRouter"
---

# OpenRouter

OpenRouter provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## CLI setup

```bash
mullusi onboard --auth-choice openrouter-api-key
```

## Config snippet

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/auto" },
    },
  },
}
```

## Notes

- Model refs are `openrouter/<provider>/<model>`.
- Onboarding defaults to `openrouter/auto`. Switch to a concrete model later with
  `mullusi models set openrouter/<provider>/<model>`.
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
- OpenRouter uses a Bearer token with your API key under the hood.
- On real OpenRouter requests (`https://openrouter.ai/api/v1`), Mullusi also
  adds OpenRouter's documented app-attribution headers:
  `HTTP-Referer: https://mullusi.com`, `X-OpenRouter-Title: Mullusi`, and
  `X-OpenRouter-Categories: cli-agent`.
- On verified OpenRouter routes, Anthropic model refs also keep the
  OpenRouter-specific Anthropic `cache_control` markers that Mullusi uses for
  better prompt-cache reuse on system/developer prompt blocks.
- If you repoint the OpenRouter provider at some other proxy/base URL, Mullusi
  does not inject those OpenRouter-specific headers or Anthropic cache markers.
- OpenRouter still runs through the proxy-style OpenAI-compatible path, so
  native OpenAI-only request shaping such as `serviceTier`, Responses `store`,
  OpenAI reasoning-compat payloads, and prompt-cache hints is not forwarded.
- Gemini-backed OpenRouter refs stay on the proxy-Gemini path: Mullusi keeps
  Gemini thought-signature sanitation there, but does not enable native Gemini
  replay validation or bootstrap rewrites.
- On supported non-`auto` routes, Mullusi maps the selected thinking level to
  OpenRouter proxy reasoning payloads. Unsupported model hints and
  `openrouter/auto` skip that reasoning injection.
- If you pass OpenRouter provider routing under model params, Mullusi forwards
  it as OpenRouter routing metadata before the shared stream wrappers run.
