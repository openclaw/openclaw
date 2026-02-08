---
summary: "Gamitin ang OpenCode Zen (mga piniling model) sa OpenClaw"
read_when:
  - Gusto mo ang OpenCode Zen para sa access sa mga model
  - Gusto mo ng isang piniling listahan ng mga model na angkop sa coding
title: "OpenCode Zen"
x-i18n:
  source_path: providers/opencode.md
  source_hash: b3b5c640ac32f317
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:45Z
---

# OpenCode Zen

Ang OpenCode Zen ay isang **piniling listahan ng mga model** na inirerekomenda ng OpenCode team para sa mga coding agent.
Isa itong opsyonal, hosted na paraan ng access sa mga model na gumagamit ng API key at ng `opencode` provider.
Kasalukuyang nasa beta ang Zen.

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
