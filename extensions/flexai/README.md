# OpenClaw FlexAI Provider

Official OpenClaw provider plugin for [FlexAI](https://flex.ai), a hosted
inference service that serves open-weight models through an OpenAI-compatible
API.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/flexai-provider
openclaw gateway restart
```

Then set a FlexAI API key and pick a model:

```bash
openclaw onboard --auth-choice flexai-api-key
openclaw models list --provider flexai
```

`FLEXAI_API_KEY` in the Gateway environment works too.

See <https://docs.openclaw.ai/providers/flexai> for setup, the seeded model
table, and the measured per-model capability notes.
