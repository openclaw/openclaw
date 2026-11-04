# OpenClaw NovitaAI provider

Official OpenClaw provider plugin for NovitaAI's OpenAI-compatible API.

Video task polling honors the provider's private-network policy even without a
proxy override. Generated video downloads keep their separate asset boundary.

## Install

```sh
openclaw plugins install @openclaw/novita-provider
openclaw gateway restart
```

## Docs

See `docs/providers/novita.md` in the OpenClaw repository, or the published
docs at `https://docs.openclaw.ai/providers/novita`.
