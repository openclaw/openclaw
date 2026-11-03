# OpenClaw Requesty Provider

Official OpenClaw provider plugin for [Requesty](https://requesty.ai), an
OpenAI-compatible router for hundreds of models behind one API key. Discovery lists
the managed policies your key can route to, addressed by bare model name.

Requesty is bundled with OpenClaw and releases together with the host. No separate
plugin installation is required.

Configure it through onboarding:

```bash
openclaw onboard --auth-choice requesty-api-key
```

See <https://docs.openclaw.ai/providers/requesty> for setup and configuration.
