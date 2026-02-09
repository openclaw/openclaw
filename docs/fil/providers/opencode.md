---
summary: "Gamitin ang OpenCode Zen (mga piniling model) sa OpenClaw"
read_when:
  - Gusto mo ang OpenCode Zen para sa access sa mga model
  - Gusto mo ng isang piniling listahan ng mga model na angkop sa coding
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen is a **curated list of models** recommended by the OpenCode team for coding agents.
It is an optional, hosted model access path that uses an API key and the `opencode` provider.
Zen is currently in beta.

## Setup ng CLI

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Snippet ng config

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Mga tala

- Sinusuportahan din ang `OPENCODE_ZEN_API_KEY`.
- Mag-sign in ka sa Zen, magdagdag ng mga detalye sa billing, at kopyahin ang iyong API key.
- Naniningil ang OpenCode Zen kada request; tingnan ang OpenCode dashboard para sa mga detalye.
