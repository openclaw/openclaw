---
summary: "Brug OpenCode Zen (kuraterede modeller) med OpenClaw"
read_when:
  - Du vil have OpenCode Zen til modeladgang
  - Du vil have en kurateret liste over kodevenlige modeller
title: "OpenCode Zen"
x-i18n:
  source_path: providers/opencode.md
  source_hash: b3b5c640ac32f317
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:30Z
---

# OpenCode Zen

OpenCode Zen er en **kurateret liste af modeller**, som anbefales af OpenCode-teamet til kodeagenter.
Det er en valgfri, hostet adgangsvej til modeller, der bruger en API-nøgle og `opencode`-udbyderen.
Zen er i øjeblikket i beta.

## CLI-opsætning

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Konfigurationsudsnit

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Noter

- `OPENCODE_ZEN_API_KEY` understøttes også.
- Du logger ind på Zen, tilføjer betalingsoplysninger og kopierer din API-nøgle.
- OpenCode Zen fakturerer pr. anmodning; se OpenCode-dashboardet for detaljer.
